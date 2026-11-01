import { ChannelType, PermissionFlagsBits, type Client, type TextChannel } from 'discord.js';
import { and, eq, lte, inArray, ne } from 'drizzle-orm';
import { jobs, sessions, submissions, files, processedInputs } from '../../database/schema';
import { FormEngine } from './engine';
import { AttachmentStorage } from './storage';
import { FormError, type FormConfiguration, type DeliveryJob } from './model';
import { panel, prompt, buttons, button, answerPages, safe } from './views';

export class DiscordDelivery {
	private interval: NodeJS.Timeout | undefined;
	private running = false;
	private lastCleanup = 0;

	public constructor(
		private readonly client: Client,
		private readonly engine: FormEngine,
		private readonly storage: AttachmentStorage
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
			PermissionFlagsBits.CreatePrivateThreads,
			PermissionFlagsBits.SendMessagesInThreads,
			PermissionFlagsBits.ReadMessageHistory,
			PermissionFlagsBits.ManageThreads,
			PermissionFlagsBits.AttachFiles
		];

		if (!channel.permissionsFor(botMember)?.has(requiredPermissions)) {
			throw new FormError(
				'The bot needs view, send, private-thread, thread-management, history and attachment permissions in the review channel.'
			);
		}

		if (
			channel
				.permissionsFor(channel.guild.roles.everyone)
				?.has(PermissionFlagsBits.ViewChannel)
		) {
			throw new FormError('Choose a staff-only review channel hidden from @everyone.');
		}

		for (const reviewerId of configuration.reviewerIds) {
			const reviewer = await channel.guild.members.fetch({ user: reviewerId, force: true });

			if (
				!channel
					.permissionsFor(reviewer)
					?.has([
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.SendMessagesInThreads
					])
			) {
				throw new FormError(
					`Reviewer ${reviewerId} needs access to the review channel and permission to send in threads.`
				);
			}
		}

		return channel;
	}

	public async tick() {
		if (this.running || !this.client.isReady()) {
			return;
		}

		this.running = true;

		try {
			for (let deliveryCount = 0; deliveryCount < 10; deliveryCount++) {
				const deliveryJob = await this.engine.claimDeliveryJob();

				if (!deliveryJob) {
					break;
				}

				try {
					await this.deliver(deliveryJob);
					await this.engine.database.delete(jobs).where(eq(jobs.id, deliveryJob.id));
				} catch (error) {
					const errorCode =
						error instanceof FormError
							? 'configuration_or_repair_required'
							: 'discord_delivery_failed';
					const retryDelay = Math.min(
						3600000,
						10000 * 2 ** Math.min(deliveryJob.attempts, 8)
					);

					await this.engine.database
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
		}
	}

	private async deliver(deliveryJob: DeliveryJob) {
		switch (deliveryJob.kind) {
			case 'prompt':
				return this.deliverPrompt(deliveryJob);
			case 'review':
				return this.deliverReview(deliveryJob.payload.id);
			case 'receipt':
				return this.deliverDecision(deliveryJob.payload.id);
			case 'close':
				return this.archiveReview(deliveryJob.payload.id);
		}
	}

	private async deliverPrompt(deliveryJob: DeliveryJob) {
		const session = await this.engine.findSession(deliveryJob.payload.id);

		if (
			session.status !== 'prompt' ||
			session.version !== deliveryJob.payload.version ||
			session.expiresAt <= new Date()
		) {
			return;
		}

		const applicant = await this.client.users.fetch(session.userId);
		const directMessages = await applicant.createDM();
		const marker = `zf-prompt:${session.id}:${session.version}`;
		const recentMessages = await directMessages.messages.fetch({ limit: 100 });
		let questionMessage = recentMessages.find(
			(message) =>
				message.author.id === this.client.user?.id &&
				JSON.stringify(message.components).includes(marker)
		);

		if (!questionMessage) {
			const content = prompt(session);

			if (session.position >= session.snapshot.questions.length) {
				content.components[0]!.addTextDisplayComponents((display) =>
					display.setContent(`-# ${marker}`)
				);
			}

			questionMessage = await directMessages.send(content);
		}

		await this.engine.database
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

	private async findReviewThread(channel: TextChannel, submissionId: string) {
		const threadName = `submission-${submissionId}`;
		const activeThreads = await channel.threads.fetchActive();
		const activeMatch = activeThreads.threads.find((thread) => thread.name === threadName);

		if (activeMatch) {
			return activeMatch;
		}

		let archiveCursor: Date | undefined;

		for (let archivePage = 0; archivePage < 100; archivePage++) {
			const archivedThreads = await channel.threads.fetchArchived({
				type: 'private',
				limit: 100,
				...(archiveCursor ? { before: archiveCursor } : {})
			});
			const archivedMatch = archivedThreads.threads.find(
				(thread) => thread.name === threadName
			);

			if (archivedMatch) {
				return archivedMatch;
			}

			if (!archivedThreads.hasMore) {
				return null;
			}

			const oldestThread = archivedThreads.threads.last();

			if (!oldestThread?.archiveTimestamp) {
				throw new FormError('Could not reconcile archived review threads.');
			}

			archiveCursor = new Date(oldestThread.archiveTimestamp);
		}

		throw new FormError('Review archive reconciliation needs administrator attention.');
	}

	private async deliverReview(submissionId: string) {
		const submission = await this.engine.findSubmission(submissionId);

		if (
			submission.deliveryState === 'ready' ||
			submission.status !== 'pending' ||
			submission.expiresAt <= new Date()
		) {
			return;
		}

		const currentForm = await this.engine.findForm(submission.formId);
		const reviewConfiguration = {
			...submission.snapshot,
			reviewerIds: currentForm.data.reviewerIds
		};
		const channel = await this.validateReviewChannel(submission.guildId, reviewConfiguration);
		let thread = submission.threadId
			? await this.client.channels.fetch(submission.threadId)
			: await this.findReviewThread(channel, submission.id);

		if (!thread) {
			if (submission.deliveryState !== 'queued') {
				throw new FormError(
					'The result of thread creation is uncertain. Use the repair command after checking the staff channel.'
				);
			}

			await this.engine.database
				.update(submissions)
				.set({ deliveryState: 'creating' })
				.where(eq(submissions.id, submission.id));
			thread = await channel.threads.create({
				name: `submission-${submission.id}`,
				type: ChannelType.PrivateThread,
				invitable: false,
				autoArchiveDuration: 1440
			});
		}

		if (thread.type !== ChannelType.PrivateThread || thread.parentId !== channel.id) {
			throw new FormError(
				'The stored review destination is not a private thread in the configured channel.'
			);
		}

		await this.engine.database
			.update(submissions)
			.set({ threadId: thread.id, deliveryState: 'posting' })
			.where(eq(submissions.id, submission.id));

		if (thread.archived) {
			await thread.setArchived(false);
		}

		for (const reviewerId of reviewConfiguration.reviewerIds) {
			await thread.members.add(reviewerId);
		}

		const existingMessages = await thread.messages.fetch({ limit: 100 });
		const hasPart = (marker: string) =>
			existingMessages.some(
				(message) =>
					message.author.id === this.client.user?.id &&
					JSON.stringify(message.components).includes(marker)
			);

		for (
			let questionIndex = 0;
			questionIndex < submission.snapshot.questions.length;
			questionIndex++
		) {
			const question = submission.snapshot.questions[questionIndex]!;
			const answer = submission.answers[questionIndex];

			for (const [answerPage, answerText] of answerPages(answer).entries()) {
				const marker = `zf-review:${submission.id}:${questionIndex}:${answerPage}`;

				if (hasPart(marker)) {
					continue;
				}

				const content = panel(
					`## ${safe(submission.snapshot.name)}\nApplicant: ${submission.userId}\nQuestion ${questionIndex + 1} of ${submission.snapshot.questions.length}\n### ${safe(question.prompt)}\n${answerText}\n-# ${marker}`
				);

				if (Array.isArray(answer) && answerPage === 0) {
					for (const attachment of answer) {
						content.components[0]!.addFileComponents((file) =>
							file.setURL(`attachment://${attachment.name}`).setSpoiler(true)
						);
					}

					await thread.send({
						...content,
						files: answer.map((attachment) => ({
							attachment: this.storage.path(attachment.key),
							name: attachment.name
						}))
					});
				} else {
					await thread.send(content);
				}
			}
		}

		const controlsMarker = `zf-review-controls:${submission.id}`;

		if (!hasPart(controlsMarker)) {
			await thread.send(
				panel(
					`Submission ${submission.id}\nOne authorized reviewer can make the final decision.\n-# ${controlsMarker}`,
					[
						buttons(
							button(`zf:r:${submission.id}:accepted`, 'Accept'),
							button(`zf:r:${submission.id}:rejected`, 'Reject')
						)
					]
				)
			);
		}

		await this.engine.database
			.update(submissions)
			.set({ deliveryState: 'ready', snapshot: reviewConfiguration })
			.where(eq(submissions.id, submission.id));
	}

	private async deliverDecision(submissionId: string) {
		const submission = await this.engine.findSubmission(submissionId);
		const applicant = await this.client.users.fetch(submission.userId);
		const channel = await applicant.createDM();
		const marker = `zf-decision:${submission.id}`;
		const recentMessages = await channel.messages.fetch({ limit: 100 });

		if (
			!recentMessages.some(
				(message) =>
					message.author.id === this.client.user?.id &&
					JSON.stringify(message.components).includes(marker)
			)
		) {
			await channel.send(
				panel(
					`## ${safe(submission.snapshot.name)}\nYour submission was ${submission.status}.\n${safe(submission.reason ?? '')}\n-# ${marker}`
				)
			);
		}
	}

	private async archiveReview(submissionId: string) {
		const submission = await this.engine.findSubmission(submissionId);

		if (!submission.threadId || submission.status === 'pending' || submission.archived) {
			return;
		}

		const thread = await this.client.channels.fetch(submission.threadId);

		if (!thread || thread.type !== ChannelType.PrivateThread) {
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
		await this.engine.database
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
		const submission = await this.engine.findSubmission(submissionId);

		if (submission.guildId !== guildId || submission.status !== 'pending') {
			throw new FormError('Choose a pending submission from this server.');
		}

		const channel = await this.validateReviewChannel(guildId, submission.snapshot);
		const discoveredThread = await this.findReviewThread(channel, submission.id);

		if (!discoveredThread && !allowRecreate) {
			throw new FormError(
				'No matching thread was found. Check the staff channel, then use recreate:true to create a replacement.'
			);
		}

		await this.engine.database.transaction(async (database) => {
			await database
				.update(submissions)
				.set({
					threadId: discoveredThread?.id ?? null,
					deliveryState: discoveredThread ? 'posting' : 'queued'
				})
				.where(eq(submissions.id, submission.id));
			await database.delete(jobs).where(eq(jobs.dedupe, `review:${submission.id}:0`));
			await this.engine.enqueueDelivery(database, 'review', submission.id);
			await this.engine.recordAuditEvent(
				database,
				guildId,
				actorId,
				'review.repair',
				submission.id
			);
		});
	}

	private async reconcileReviewers() {
		const openReviews = await this.engine.database
			.select()
			.from(submissions)
			.where(and(eq(submissions.status, 'pending'), eq(submissions.deliveryState, 'ready')));

		for (const submission of openReviews) {
			const form = await this.engine.findForm(submission.formId);
			const previousReviewers = submission.snapshot.reviewerIds;
			const currentReviewers = form.data.reviewerIds;

			if (
				previousReviewers.length === currentReviewers.length &&
				previousReviewers.every((reviewerId) => currentReviewers.includes(reviewerId))
			) {
				continue;
			}

			try {
				const thread = submission.threadId
					? await this.client.channels.fetch(submission.threadId)
					: null;

				if (!thread || thread.type !== ChannelType.PrivateThread) {
					continue;
				}

				if (thread.archived) {
					await thread.setArchived(false);
				}

				for (const reviewerId of previousReviewers.filter(
					(previousId) => !currentReviewers.includes(previousId)
				)) {
					await thread.members.remove(reviewerId);
				}

				for (const reviewerId of currentReviewers) {
					await thread.members.add(reviewerId);
				}

				await this.engine.database
					.update(submissions)
					.set({ snapshot: { ...submission.snapshot, reviewerIds: currentReviewers } })
					.where(eq(submissions.id, submission.id));
			} catch {
				console.error(`Reviewer membership synchronization failed for ${submission.id}.`);
			}
		}
	}

	private async cleanup() {
		await this.reconcileReviewers();
		await this.engine.database
			.update(sessions)
			.set({ status: 'expired' })
			.where(
				and(
					lte(sessions.expiresAt, new Date()),
					inArray(sessions.status, ['prompt', 'answer', 'confirm', 'paused'])
				)
			);
		const expiredSubmissions = await this.engine.database
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
					await thread.delete('ZoraForms answer retention period ended');
				}
			}

			await this.engine.database.transaction(async (database) => {
				await database
					.update(submissions)
					.set({
						answers: [],
						snapshot: { ...submission.snapshot, questions: [] },
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
			});
		}

		const expiredDrafts = await this.engine.database
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
			await this.engine.database
				.update(sessions)
				.set({ answers: [], snapshot: { ...session.snapshot, questions: [] } })
				.where(eq(sessions.id, session.id));
		}

		const expiredFiles = await this.engine.database
			.select()
			.from(files)
			.where(lte(files.expiresAt, new Date()))
			.limit(100);
		await this.storage.remove(expiredFiles);
		await this.engine.database
			.delete(processedInputs)
			.where(lte(processedInputs.createdAt, new Date(Date.now() - 30 * 86400000)));
	}
}
