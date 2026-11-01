import { QuestionMedia } from '../services/question-media';
import { getBotName } from '../../../lib/environment';
import {
	ChannelType,
	PermissionFlagsBits,
	type Client,
	type Message,
	type TextChannel
} from 'discord.js';
import { and, eq, lte, inArray, ne } from 'drizzle-orm';
import {
	jobs,
	sessions,
	submissions,
	files,
	processedInputs,
	rateLimitBuckets,
	submissionReplies
} from '../../../database/schema';
import { FormService } from '../services/form-service';
import { AttachmentTransfer } from '../services/attachment-transfer';
import { FormError } from '../domain/rules';
import type { FormConfiguration, DeliveryJob } from '../domain/types';
import { applicantCard, reviewThreadName } from './applicant-card';
import {
	panel,
	prompt,
	buttons,
	button,
	answerPages,
	safe,
	hiddenMarker,
	markPanel,
	questionHeading
} from './components';

type SubmissionRecord = typeof submissions.$inferSelect;

export class MissingReviewThreadError extends FormError {}

export class DiscordDelivery {
	private interval: NodeJS.Timeout | undefined;
	private running = false;
	private wakeRequested = false;
	private lastCleanup = 0;

	public constructor(
		private readonly client: Client,
		private readonly formService: FormService,
		private readonly attachments: AttachmentTransfer,
		public readonly questionMedia = new QuestionMedia(client)
	) {}

	public start() {
		this.interval = setInterval(() => void this.tick(), 2000);
		this.interval.unref();
		void this.tick();
	}

	public async stop() {
		clearInterval(this.interval);
		while (this.running) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	public async validateReviewChannel(guildId: string, configuration: FormConfiguration) {
		const channel = await this.client.channels.fetch(configuration.reviewChannelId);

		if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) {
			throw new FormError('Choose a standard text channel in this server for staff review.');
		}

		const botMember = await channel.guild.members.fetchMe();
		const requiredPermissions = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.CreatePublicThreads,
			PermissionFlagsBits.SendMessagesInThreads,
			PermissionFlagsBits.ReadMessageHistory,
			PermissionFlagsBits.ManageThreads,
			PermissionFlagsBits.AttachFiles
		];

		if (!channel.permissionsFor(botMember)?.has(requiredPermissions)) {
			throw new FormError(
				'The bot needs view, send, thread-creation, thread-management, history and attachment permissions in the review channel.'
			);
		}

		return channel;
	}

	// Starts delivery straight away instead of waiting for the next poll.
	public wake() {
		this.wakeRequested = true;
		return this.tick();
	}

	public async tick() {
		if (this.running || !this.client.isReady()) {
			return;
		}

		this.running = true;
		this.wakeRequested = false;

		try {
			for (let deliveryCount = 0; deliveryCount < 10; deliveryCount++) {
				const deliveryJob = await this.formService.claimDeliveryJob();

				if (!deliveryJob) {
					break;
				}

				try {
					await this.deliver(deliveryJob);
					await this.formService.database.delete(jobs).where(eq(jobs.id, deliveryJob.id));
				} catch (error) {
					const errorCode =
						error instanceof FormError
							? 'configuration_or_repair_required'
							: 'discord_delivery_failed';
					const retryDelay = Math.min(
						3600000,
						10000 * 2 ** Math.min(deliveryJob.attempts, 8)
					);

					await this.formService.database
						.update(jobs)
						.set({
							leaseUntil: null,
							nextAttemptAt: new Date(Date.now() + retryDelay),
							errorCode
						})
						.where(eq(jobs.id, deliveryJob.id));

					console.error(
						`Delivery ${deliveryJob.kind} for ${deliveryJob.payload.id} failed (${errorCode}).`
					);
				}
			}

			if (Date.now() - this.lastCleanup > 60000) {
				await this.cleanup();
				this.lastCleanup = Date.now();
			}
		} catch {
			console.error('A delivery or retention operation failed. It will retry.');
		} finally {
			this.running = false;

			if (this.wakeRequested) {
				void this.tick();
			}
		}
	}

	private async deliver(deliveryJob: DeliveryJob) {
		switch (deliveryJob.kind) {
			case 'prompt':
				return this.deliverPrompt(deliveryJob);
			case 'review':
				return this.deliverReview(deliveryJob.payload.id, deliveryJob.id);
			case 'receipt':
				return this.deliverDecision(deliveryJob.payload.id);
			case 'close':
				return this.archiveReview(deliveryJob.payload.id);
			case 'reply':
				return this.deliverReply(deliveryJob.payload.id);
		}
	}

	private async deliverPrompt(deliveryJob: DeliveryJob) {
		const session = await this.formService.findSession(deliveryJob.payload.id);

		if (
			session.status !== 'prompt' ||
			session.version !== deliveryJob.payload.version ||
			session.expiresAt <= new Date()
		) {
			return;
		}

		const applicant = await this.client.users.fetch(session.userId);
		const directMessages = await applicant.createDM();
		const marker = `prompt:${session.id}:${session.version}`;
		// Only a retry can find its question already sent, so a first attempt skips this lookup.
		const recentMessages =
			deliveryJob.attempts === 0 ? null : await directMessages.messages.fetch({ limit: 100 });
		let questionMessage = recentMessages?.find((message) => this.isMarked(message, marker));

		if (!questionMessage) {
			questionMessage = await directMessages.send(
				await this.questionMedia.decorate(
					markPanel(prompt(session), marker),
					session.snapshot.questions[session.position]
				)
			);
		}

		await this.formService.database
			.update(sessions)
			.set({
				promptId: questionMessage.id,
				status: session.position >= session.snapshot.questions.length ? 'confirm' : 'answer'
			})
			.where(
				and(
					eq(sessions.id, session.id),
					eq(sessions.version, session.version),
					eq(sessions.status, 'prompt')
				)
			);
	}

	private isMarked(message: Message, key: string) {
		const marker = hiddenMarker(key);

		return (
			message.author.id === this.client.user?.id &&
			message.components.some((component) => component.id === marker)
		);
	}

	// A thread started from a message shares that message's id.
	private async findReviewThread(submission: {
		threadId: string | null;
		reviewMessageId: string | null;
	}) {
		const threadId = submission.threadId ?? submission.reviewMessageId;

		if (!threadId) {
			return null;
		}

		try {
			return await this.client.channels.fetch(threadId);
		} catch (error) {
			if (typeof error === 'object' && error && 'code' in error && error.code === 10003) {
				return null;
			}

			throw error;
		}
	}

	private async postApplicantCard(
		channel: TextChannel,
		submission: SubmissionRecord,
		deliveryId: string
	) {
		const user = await this.client.users.fetch(submission.userId, { force: true });
		const member = await channel.guild.members
			.fetch({ user: submission.userId, force: true })
			.catch((error) => {
				if (typeof error === 'object' && error && 'code' in error && error.code === 10007) {
					return null;
				}

				throw error;
			});
		let card = submission.reviewMessageId
			? await channel.messages.fetch(submission.reviewMessageId).catch(() => null)
			: null;

		if (!card) {
			await this.formService.database
				.update(submissions)
				.set({ deliveryState: 'creating' })
				.where(eq(submissions.id, submission.id));
			// Discord returns the existing message when a retry repeats this nonce shortly after.
			// Recovery queues a new delivery, so a replacement card gets a new nonce.
			card = await channel.send({
				...applicantCard(user, member, submission.snapshot.name),
				nonce: deliveryId.replaceAll('-', '').slice(0, 25),
				enforceNonce: true
			});
			await this.formService.database
				.update(submissions)
				.set({ reviewMessageId: card.id })
				.where(eq(submissions.id, submission.id));
		}

		return card.startThread({
			name: reviewThreadName(user, submission.snapshot.name),
			autoArchiveDuration: 1440
		});
	}

	private async deliverReview(submissionId: string, deliveryId: string) {
		const submission = await this.formService.findSubmission(submissionId);

		if (
			submission.deliveryState === 'ready' ||
			submission.status !== 'pending' ||
			submission.expiresAt <= new Date()
		) {
			return;
		}

		const channel = await this.validateReviewChannel(submission.guildId, submission.snapshot);
		const thread =
			(await this.findReviewThread(submission)) ??
			(await this.postApplicantCard(channel, submission, deliveryId));

		if (thread.type !== ChannelType.PublicThread || thread.parentId !== channel.id) {
			throw new FormError(
				'The stored review destination is not a submission thread in the configured channel.'
			);
		}

		await this.formService.database
			.update(submissions)
			.set({ threadId: thread.id, deliveryState: 'posting' })
			.where(eq(submissions.id, submission.id));

		if (thread.archived) {
			await thread.setArchived(false);
		}

		const existingMessages = await thread.messages.fetch({ limit: 100 });
		const hasPart = (marker: string) =>
			existingMessages.some((message) => this.isMarked(message, marker));

		for (
			let questionIndex = 0;
			questionIndex < submission.snapshot.questions.length;
			questionIndex++
		) {
			const question = submission.snapshot.questions[questionIndex]!;
			const answer = submission.answers[questionIndex];

			const pages = answerPages(answer);

			for (const [answerPage, answerText] of pages.entries()) {
				const marker = `review:${submission.id}:${questionIndex}:${answerPage}`;

				if (hasPart(marker)) {
					continue;
				}

				const content = markPanel(
					panel(
						`-# Question ${questionIndex + 1} of ${submission.snapshot.questions.length}${pages.length > 1 ? ` · Part ${answerPage + 1} of ${pages.length}` : ''}\n${questionHeading(question.prompt)}\n${answerText}`
					),
					marker
				);

				if (Array.isArray(answer) && answerPage === 0) {
					for (const attachment of answer) {
						content.components[0]!.addFileComponents((file) =>
							file.setURL(`attachment://${attachment.name}`).setSpoiler(true)
						);
					}

					await thread.send({
						...content,
						files: await Promise.all(
							answer.map((attachment) => this.attachments.buffer(attachment))
						)
					});
				} else {
					await thread.send(content);
				}
			}
		}

		const controlsMarker = `review-controls:${submission.id}`;

		if (!hasPart(controlsMarker)) {
			await thread.send(
				markPanel(
					panel(
						`One authorized reviewer can make the final decision.\n-# Submission ID: \`${submission.id}\``,
						[
							buttons(
								button(`zf:r:${submission.id}:accepted`, 'Accept'),
								button(`zf:r:${submission.id}:rejected`, 'Reject'),
								button(`zf:r:${submission.id}:reply`, 'Reply')
							)
						]
					),
					controlsMarker
				)
			);
		}

		await this.formService.database
			.update(submissions)
			.set({ deliveryState: 'ready' })
			.where(eq(submissions.id, submission.id));
	}

	private async deliverDecision(submissionId: string) {
		const submission = await this.formService.findSubmission(submissionId);
		const applicant = await this.client.users.fetch(submission.userId);
		const channel = await applicant.createDM();
		const marker = `decision:${submission.id}`;
		const recentMessages = await channel.messages.fetch({ limit: 100 });

		if (!recentMessages.some((message) => this.isMarked(message, marker))) {
			await channel.send(
				markPanel(
					panel(
						`## ${safe(submission.snapshot.name)}\nYour submission was ${submission.status}.\n${safe(submission.reason ?? '')}`
					),
					marker
				)
			);
		}
	}

	private async deliverReply(replyId: string) {
		const [reply] = await this.formService.database
			.select()
			.from(submissionReplies)
			.where(eq(submissionReplies.id, replyId));

		if (!reply || reply.deliveredAt) {
			return;
		}

		const submission = await this.formService.findSubmission(reply.submissionId);

		if (submission.deliveryState === 'purged') {
			return;
		}

		if (submission.threadId) {
			const thread = await this.client.channels.fetch(submission.threadId);

			if (thread?.type === ChannelType.PublicThread) {
				const wasArchived = thread.archived;

				if (wasArchived) {
					await thread.setArchived(false);
				}

				const marker = `reply-log:${reply.id}`;
				const threadMessages = await thread.messages.fetch({ limit: 100 });

				if (!threadMessages.some((message) => this.isMarked(message, marker))) {
					await thread.send(
						markPanel(
							panel(`Staff reply by <@${reply.actorId}>\n${safe(reply.content)}`),
							marker
						)
					);
				}

				const currentSubmission = await this.formService.findSubmission(submission.id);

				if (currentSubmission.status !== 'pending') {
					await thread.setLocked(true);
				}

				if (wasArchived || currentSubmission.status !== 'pending') {
					await thread.setArchived(true);
				}
			}
		}

		const channel = await (await this.client.users.fetch(submission.userId)).createDM();
		const marker = `reply:${reply.id}`;
		const messages = await channel.messages.fetch({ limit: 100 });

		if (!messages.some((message) => this.isMarked(message, marker))) {
			await channel.send(
				markPanel(
					panel(
						`## Staff reply: ${safe(submission.snapshot.name)}\n${safe(reply.content)}`
					),
					marker
				)
			);
		}

		await this.formService.database
			.update(submissionReplies)
			.set({ deliveredAt: new Date() })
			.where(eq(submissionReplies.id, replyId));
	}

	private async archiveReview(submissionId: string) {
		const submission = await this.formService.findSubmission(submissionId);

		if (!submission.threadId || submission.status === 'pending' || submission.archived) {
			return;
		}

		const thread = await this.client.channels.fetch(submission.threadId);

		if (!thread || thread.type !== ChannelType.PublicThread) {
			throw new FormError('Review thread is missing.');
		}

		if (thread.archived) {
			await thread.setArchived(false);
		}
		await thread.send(
			panel(
				`This submission was ${submission.status} by reviewer ${submission.reviewerId}.\n${safe(submission.reason ?? '')}\nThe review is complete and this thread is being archived.`
			)
		);
		await thread.setLocked(true);
		await thread.setArchived(true);
		await this.formService.database
			.update(submissions)
			.set({ archived: true })
			.where(eq(submissions.id, submission.id));
	}

	public async repairReview(
		submissionId: string,
		guildId: string,
		actorId: string,
		allowRecreate: boolean
	) {
		const submission = await this.formService.findSubmission(submissionId);

		if (submission.guildId !== guildId || submission.status !== 'pending') {
			throw new FormError('Choose a pending submission from this server.');
		}

		await this.validateReviewChannel(guildId, submission.snapshot);
		const discoveredThread = await this.findReviewThread(submission);

		if (!discoveredThread && !allowRecreate) {
			throw new MissingReviewThreadError(
				'No matching thread was found. Check the submission channel, then create a replacement if the thread is really gone.'
			);
		}

		if (!discoveredThread && submission.reviewMessageId) {
			await this.questionMedia.deleteMessage(
				submission.snapshot.reviewChannelId,
				submission.reviewMessageId
			);
		}

		await this.formService.database.transaction(async (database) => {
			await database
				.update(submissions)
				.set({
					threadId: discoveredThread?.id ?? null,
					reviewMessageId: discoveredThread ? submission.reviewMessageId : null,
					deliveryState: discoveredThread ? 'posting' : 'queued'
				})
				.where(eq(submissions.id, submission.id));
			await database.delete(jobs).where(eq(jobs.dedupe, `review:${submission.id}:0`));
			await this.formService.enqueueDelivery(database, 'review', submission.id);
			await this.formService.recordAuditEvent(
				database,
				guildId,
				actorId,
				'review.repair',
				submission.id
			);
		});
	}

	private async cleanup() {
		await this.formService.database
			.update(sessions)
			.set({ status: 'expired' })
			.where(
				and(
					lte(sessions.expiresAt, new Date()),
					inArray(sessions.status, ['prompt', 'answer', 'confirm', 'paused'])
				)
			);
		const expiredSubmissions = await this.formService.database
			.select()
			.from(submissions)
			.where(
				and(lte(submissions.expiresAt, new Date()), ne(submissions.deliveryState, 'purged'))
			)
			.limit(20);

		for (const submission of expiredSubmissions) {
			if (submission.threadId) {
				const thread = await this.client.channels
					.fetch(submission.threadId)
					.catch((error) => {
						if (
							typeof error === 'object' &&
							error &&
							'code' in error &&
							error.code === 10003
						) {
							return null;
						}
						throw error;
					});

				if (thread) {
					await thread.delete(`${getBotName()} answer retention period ended`);
				}
			}

			if (submission.reviewMessageId) {
				await this.questionMedia.deleteMessage(
					submission.snapshot.reviewChannelId,
					submission.reviewMessageId
				);
			}

			await this.formService.database.transaction(async (database) => {
				await database
					.update(submissions)
					.set({
						answers: [],
						snapshot: { ...submission.snapshot, questions: [] },
						reviewMessageId: null,
						deliveryState: 'purged',
						status: submission.status === 'pending' ? 'rejected' : submission.status,
						archived: true
					})
					.where(eq(submissions.id, submission.id));
				await database
					.update(sessions)
					.set({ answers: [], snapshot: { ...submission.snapshot, questions: [] } })
					.where(eq(sessions.id, submission.sessionId));
				await database.delete(jobs).where(eq(jobs.payload, { id: submission.id }));
				await database
					.delete(submissionReplies)
					.where(eq(submissionReplies.submissionId, submission.id));
			});
		}

		const expiredDrafts = await this.formService.database
			.select()
			.from(sessions)
			.where(
				and(
					lte(sessions.expiresAt, new Date()),
					inArray(sessions.status, ['expired', 'cancelled']),
					ne(sessions.answers, [])
				)
			)
			.limit(100);

		for (const session of expiredDrafts) {
			await this.formService.database
				.update(sessions)
				.set({ answers: [], snapshot: { ...session.snapshot, questions: [] } })
				.where(eq(sessions.id, session.id));
		}

		const expiredFiles = await this.formService.database
			.select()
			.from(files)
			.where(lte(files.expiresAt, new Date()))
			.limit(100);
		await this.attachments.remove(expiredFiles);
		await this.formService.database
			.delete(rateLimitBuckets)
			.where(lte(rateLimitBuckets.windowStartedAt, new Date(Date.now() - 86400000)));
		await this.formService.database
			.delete(processedInputs)
			.where(lte(processedInputs.createdAt, new Date(Date.now() - 30 * 86400000)));

		for (const questionFile of await this.formService.findUnusedQuestionFiles()) {
			try {
				await this.questionMedia.deleteMessage(
					questionFile.channelId,
					questionFile.messageId
				);
				await this.formService.forgetRetiredQuestionFile(questionFile.messageId);
			} catch {
				console.error('A retired question file could not be removed. It will retry.');
			}
		}
	}
}
