import { StaffPermissions } from './staff-permissions';
import type { StaffIdentity } from '../domain/permissions';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, lte, inArray, or, isNull, sql, desc, notExists } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database, Queryable } from '../../../database/database';
import {
	forms,
	sessions,
	submissions,
	userLocks,
	auditEvents,
	jobs,
	processedInputs,
	files,
	retiredQuestionFiles
} from '../../../database/schema';
import {
	assertFormAccess,
	FormError,
	SubmissionLimitError,
	validateQuestionAnswer,
	outdatedControl
} from '../domain/rules';
import { formConfigurationSchema } from '../domain/schemas';
import type {
	AttachmentReference,
	FormRecord,
	FormConfiguration,
	DeliveryJob,
	QuestionnaireSession
} from '../domain/types';
const activeStates: QuestionnaireSession['status'][] = ['prompt', 'answer', 'confirm', 'paused'];
const draftExpiry = () => new Date(Date.now() + 7 * 86400000);

function retiredReferences(previous: FormConfiguration, updated: FormConfiguration) {
	const keptMessageIds = new Set(
		updated.questions.flatMap((question) =>
			question.references.map((reference) => reference.messageId)
		)
	);
	const retiredChannels = new Map<string, string>();

	for (const question of previous.questions) {
		for (const reference of question.references ?? []) {
			if (!keptMessageIds.has(reference.messageId)) {
				retiredChannels.set(reference.messageId, reference.channelId);
			}
		}
	}

	return [...retiredChannels].map(([messageId, channelId]) => ({ messageId, channelId }));
}

export class FormService {
	public constructor(public readonly database: Database) {}

	public async findForm(id: string, database: Queryable = this.database) {
		const [form] = await database.select().from(forms).where(eq(forms.id, id));
		if (!form) {
			throw new FormError('That form no longer exists.');
		}
		return form;
	}

	public listForms(guildId?: string) {
		return this.database
			.select()
			.from(forms)
			.where(guildId ? eq(forms.guildId, guildId) : eq(forms.archived, false))
			.orderBy(forms.id);
	}

	public async recordAuditEvent(
		database: Queryable,
		guildId: string,
		actorId: string,
		action: string,
		target: string
	) {
		await database.insert(auditEvents).values({
			guildId: guildId,
			actorId: actorId,
			action,
			targetId: target
		});
	}

	public async createForm(guildId: string, actorId: string, data: unknown) {
		const parsed = formConfigurationSchema.parse(data);
		const id = randomUUID();
		await this.database.transaction(async (database) => {
			await database.insert(forms).values({
				id,
				guildId: guildId,
				data: parsed
			});
			await this.recordAuditEvent(database, guildId, actorId, 'form.create', id);
		});
		return this.findForm(id);
	}

	public async editFormDraft(
		id: string,
		guildId: string,
		actorId: string,
		change: (data: FormConfiguration) => FormConfiguration
	) {
		await this.database.transaction(async (database) => {
			const [form] = await database
				.select()
				.from(forms)
				.where(and(eq(forms.id, id), eq(forms.guildId, guildId)))
				.for('update');
			if (!form) {
				throw new FormError('That form no longer exists in this server.');
			}
			const data = formConfigurationSchema.parse(change(form.data));
			data.revision = form.data.revision + 1;
			await database.update(forms).set({ data }).where(eq(forms.id, id));
			const retiredFiles = retiredReferences(form.data, data);

			if (retiredFiles.length) {
				await database
					.insert(retiredQuestionFiles)
					.values(retiredFiles)
					.onConflictDoNothing();
			}

			await this.recordAuditEvent(database, guildId, actorId, 'form.edit', id);
		});
	}

	public async findUnusedQuestionFiles() {
		const mentionsMessage = (column: AnyPgColumn) =>
			sql`${column}::text like '%' || ${retiredQuestionFiles.messageId} || '%'`;

		return this.database
			.select()
			.from(retiredQuestionFiles)
			.where(
				and(
					notExists(
						this.database
							.select({ id: forms.id })
							.from(forms)
							.where(
								or(mentionsMessage(forms.data), mentionsMessage(forms.published))
							)
					),
					notExists(
						this.database
							.select({ id: sessions.id })
							.from(sessions)
							.where(
								and(
									inArray(sessions.status, activeStates),
									mentionsMessage(sessions.snapshot)
								)
							)
					)
				)
			)
			.limit(20);
	}

	public async forgetRetiredQuestionFile(messageId: string) {
		await this.database
			.delete(retiredQuestionFiles)
			.where(eq(retiredQuestionFiles.messageId, messageId));
	}

	public async publishForm(id: string, guildId: string, actorId: string, revision: number) {
		await this.database.transaction(async (database) => {
			const [form] = await database
				.select()
				.from(forms)
				.where(and(eq(forms.id, id), eq(forms.guildId, guildId)))
				.for('update');
			if (!form || form.data.revision !== revision) {
				throw new FormError(
					'This form changed while this panel was open. Open it again and retry publishing.'
				);
			}
			if (!form.data.questions.length) {
				throw new FormError('Add at least one question before publishing.');
			}
			await database
				.update(forms)
				.set({
					published: form.data,
					archived: false
				})
				.where(eq(forms.id, id));
			await this.recordAuditEvent(database, guildId, actorId, 'form.publish', id);
		});
	}

	public async archiveForm(id: string, guildId: string, actorId: string) {
		await this.database.transaction(async (database) => {
			const form = await this.findForm(id, database);
			if (form.guildId !== guildId) {
				throw new FormError('This form belongs to another server.');
			}
			await database.update(forms).set({ archived: true }).where(eq(forms.id, id));
			await this.recordAuditEvent(database, guildId, actorId, 'form.archive', id);
		});
	}

	public async changeFormBlacklist(
		formId: string,
		guildId: string,
		actorId: string,
		subjectType: 'user' | 'role',
		change: { added: readonly string[]; removed: readonly string[] },
		expectedRevision?: number
	) {
		await this.database.transaction(async (database) => {
			const [form] = await database
				.select()
				.from(forms)
				.where(and(eq(forms.id, formId), eq(forms.guildId, guildId)))
				.for('update');

			if (!form) {
				throw new FormError('That form no longer exists in this server.');
			}

			if (expectedRevision !== undefined && form.data.revision !== expectedRevision) {
				throw new FormError(
					'This form changed while this panel was open. Open Access again and retry.'
				);
			}

			const field = subjectType === 'user' ? 'blacklist' : 'denyRoles';
			const updateList = (identifiers: string[]) => [
				...new Set([
					...identifiers.filter((identifier) => !change.removed.includes(identifier)),
					...change.added
				])
			];
			const draftList = updateList(form.data[field]);

			if (draftList.length > 100) {
				throw new FormError(
					'Each access list supports up to 100 entries. Remove some entries first.'
				);
			}

			await database
				.update(forms)
				.set({
					data: {
						...form.data,
						[field]: draftList,
						revision: form.data.revision + 1
					},
					published: form.published
						? { ...form.published, [field]: updateList(form.published[field]) }
						: null
				})
				.where(eq(forms.id, formId));

			await this.recordAuditEvent(
				database,
				guildId,
				actorId,
				`form.blacklist.${subjectType}.update`,
				formId
			);
		});
	}

	private withUserLock<T>(userId: string, work: (database: Queryable) => Promise<T>) {
		return this.database.transaction(async (database) => {
			await database.insert(userLocks).values({ userId: userId }).onConflictDoNothing();
			await database
				.select()
				.from(userLocks)
				.where(eq(userLocks.userId, userId))
				.for('update');
			return work(database);
		});
	}

	public async assertEligibility(
		form: FormRecord,
		userId: string,
		memberRoleIds: readonly string[] | null,
		database: Queryable = this.database
	) {
		assertFormAccess(form, userId, memberRoleIds);
		await this.assertSubmissionPolicy(form, userId, database);
	}

	private async assertSubmissionPolicy(form: FormRecord, userId: string, database: Queryable) {
		const rules = form.published!;
		const previous = await database
			.select({
				status: submissions.status,
				created: submissions.createdAt
			})
			.from(submissions)
			.where(and(eq(submissions.formId, form.id), eq(submissions.userId, userId)))
			.orderBy(desc(submissions.createdAt));
		if (rules.totalLimit > 0 && previous.length >= rules.totalLimit) {
			throw new SubmissionLimitError('You have reached the submission limit for this form.');
		}

		if (
			rules.pendingLimit > 0 &&
			previous.filter((submission) => submission.status === 'pending').length >=
				rules.pendingLimit
		) {
			throw new SubmissionLimitError(
				'Your earlier submission is still waiting for staff review.'
			);
		}

		const nextSubmissionAt = previous[0]
			? previous[0].created.getTime() + rules.cooldownSeconds * 1000
			: 0;

		if (rules.cooldownSeconds > 0 && nextSubmissionAt > Date.now()) {
			throw new SubmissionLimitError(
				`You can submit this form again <t:${Math.ceil(nextSubmissionAt / 1000)}:R>.`
			);
		}
	}

	public async findActiveSession(userId: string, database: Queryable = this.database) {
		const [session] = await database
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.userId, userId),
					inArray(sessions.status, activeStates),
					gt(sessions.expiresAt, new Date())
				)
			);
		return session ?? null;
	}

	public async findSession(id: string, database: Queryable = this.database) {
		const [session] = await database.select().from(sessions).where(eq(sessions.id, id));
		if (!session) {
			throw new FormError(
				'That questionnaire no longer exists. Send the bot a message to start again.'
			);
		}
		return session;
	}

	public async enqueueDelivery(
		database: Queryable,
		kind: DeliveryJob['kind'],
		id: string,
		version?: number
	) {
		await database
			.insert(jobs)
			.values({
				kind,
				payload:
					version === undefined
						? { id }
						: {
								id,
								version
							},
				dedupe: `${kind}:${id}:${version ?? 0}`
			})
			.onConflictDoNothing();
	}

	public async startSession(
		formId: string,
		userId: string,
		memberRoleIds: readonly string[] | null
	) {
		return this.withUserLock(userId, async (database) => {
			await database
				.update(sessions)
				.set({
					status: 'expired',
					version: sql`${sessions.version}+1`
				})
				.where(
					and(
						eq(sessions.userId, userId),
						lte(sessions.expiresAt, new Date()),
						inArray(sessions.status, activeStates)
					)
				);
			if (await this.findActiveSession(userId, database)) {
				throw new FormError(
					'You already have a form in progress. Resume or cancel it first.'
				);
			}
			const form = await this.findForm(formId, database);
			await this.assertEligibility(form, userId, memberRoleIds, database);
			const id = randomUUID();
			await database.insert(sessions).values({
				id,
				userId: userId,
				guildId: form.guildId,
				formId: form.id,
				snapshot: form.published!
			});
			await this.enqueueDelivery(database, 'prompt', id, 0);
			return this.findSession(id, database);
		});
	}

	private async assertCurrentSession(
		database: Queryable,
		id: string,
		userId: string,
		version: number,
		memberRoleIds: readonly string[] | null
	) {
		const session = await this.findSession(id, database);
		if (
			session.userId !== userId ||
			session.version !== version ||
			session.expiresAt.getTime() <= Date.now() ||
			!activeStates.includes(session.status)
		) {
			throw new FormError(
				'That response is out of date. Use the latest question or send a DM to resume.'
			);
		}
		await this.assertEligibility(
			await this.findForm(session.formId, database),
			userId,
			memberRoleIds,
			database
		);
		return session;
	}

	public async saveAnswer(
		id: string,
		userId: string,
		version: number,
		memberRoleIds: readonly string[] | null,
		inputId: string,
		answerText: string,
		attachments: AttachmentReference[] = [],
		reference?: string
	) {
		return this.withUserLock(userId, async (database) => {
			if (
				(
					await database
						.select()
						.from(processedInputs)
						.where(eq(processedInputs.id, inputId))
				).length
			) {
				return false;
			}
			const session = await this.assertCurrentSession(
				database,
				id,
				userId,
				version,
				memberRoleIds
			);
			if (
				session.status !== 'answer' ||
				!session.promptId ||
				BigInt(inputId) <= BigInt(session.promptId) ||
				(reference && reference !== session.promptId)
			) {
				throw new FormError('Please answer the latest question after it appears.');
			}
			const question = session.snapshot.questions[session.position];
			if (!question) {
				throw new FormError('No question is waiting for an answer right now.');
			}
			const answer = validateQuestionAnswer(question, answerText, attachments);
			const answers = [...session.answers];
			answers[session.position] = answer;
			const totalAttachmentBytes = answers.reduce<number>(
				(total, savedAnswer) =>
					total +
					(Array.isArray(savedAnswer)
						? savedAnswer.reduce((sum, attachment) => sum + attachment.size, 0)
						: 0),
				0
			);

			if (totalAttachmentBytes > 20 * 1024 * 1024) {
				throw new FormError(
					'Attachments across this questionnaire must total no more than 20 MiB.'
				);
			}

			for (const attachment of attachments) {
				const [stored] = await database
					.select()
					.from(files)
					.where(and(eq(files.key, attachment.key), eq(files.sessionId, id)));
				if (!stored) {
					throw new FormError('Upload could not be saved. Try again.');
				}
			}
			await database.insert(processedInputs).values({ id: inputId });
			await database
				.update(sessions)
				.set({
					answers,
					position: session.position + 1,
					status: 'prompt',
					version: session.version + 1,
					promptId: null,
					expiresAt: draftExpiry()
				})
				.where(eq(sessions.id, id));

			await database
				.update(files)
				.set({ expiresAt: draftExpiry() })
				.where(eq(files.sessionId, id));

			const previousAnswer = session.answers[session.position];

			if (Array.isArray(previousAnswer) && previousAnswer.length) {
				await database
					.update(files)
					.set({ expiresAt: new Date() })
					.where(
						inArray(
							files.key,
							previousAnswer.map((attachment) => attachment.key)
						)
					);
			}
			await this.enqueueDelivery(database, 'prompt', id, session.version + 1);
			return true;
		});
	}

	public async navigateSession(
		id: string,
		userId: string,
		version: number,
		memberRoleIds: readonly string[] | null,
		action: 'resume' | 'back' | 'skip' | 'pause' | 'cancel'
	) {
		await this.withUserLock(userId, async (database) => {
			const session = await this.findSession(id, database);
			if (
				session.userId !== userId ||
				session.version !== version ||
				!activeStates.includes(session.status) ||
				session.expiresAt.getTime() <= Date.now()
			) {
				throw new FormError(outdatedControl);
			}
			if (action !== 'cancel') {
				await this.assertEligibility(
					await this.findForm(session.formId, database),
					userId,
					memberRoleIds,
					database
				);
			}
			let position = session.position;
			let status: QuestionnaireSession['status'] = 'prompt';
			const answers = [...session.answers];
			if (action === 'pause') {
				status = 'paused';
			}
			if (action === 'cancel') {
				status = 'cancelled';
			}
			if (action === 'back') {
				position = Math.max(0, position - 1);
			}
			if (action === 'skip') {
				if (
					session.status !== 'answer' ||
					session.snapshot.questions[position]?.required !== false
				) {
					throw new FormError('This question cannot be skipped.');
				}
				answers[position] = null;
				position++;
			}
			await database
				.update(sessions)
				.set({
					position,
					status,
					answers,
					version: session.version + 1,
					promptId: null,
					expiresAt: action === 'cancel' ? new Date() : draftExpiry()
				})
				.where(eq(sessions.id, id));
			await database
				.update(files)
				.set({ expiresAt: status === 'cancelled' ? new Date() : draftExpiry() })
				.where(eq(files.sessionId, id));

			if (status === 'cancelled') {
				await database
					.update(files)
					.set({ expiresAt: new Date() })
					.where(eq(files.sessionId, id));
			}

			if (status === 'prompt') {
				await this.enqueueDelivery(database, 'prompt', id, session.version + 1);
			}
		});
	}

	public async editAnswerPosition(
		sessionId: string,
		userId: string,
		version: number,
		memberRoleIds: readonly string[] | null,
		questionIndex: number
	) {
		await this.withUserLock(userId, async (database) => {
			const session = await this.assertCurrentSession(
				database,
				sessionId,
				userId,
				version,
				memberRoleIds
			);

			if (
				session.status !== 'confirm' ||
				!Number.isInteger(questionIndex) ||
				!session.snapshot.questions[questionIndex]
			) {
				throw new FormError('Choose the answer to edit from your summary.');
			}

			await database
				.update(sessions)
				.set({
					position: questionIndex,
					status: 'prompt',
					version: version + 1,
					promptId: null,
					expiresAt: draftExpiry()
				})
				.where(eq(sessions.id, sessionId));

			await this.enqueueDelivery(database, 'prompt', sessionId, version + 1);
		});
	}

	public async findSubmission(id: string) {
		const [submission] = await this.database
			.select()
			.from(submissions)
			.where(eq(submissions.id, id));
		if (!submission) {
			throw new FormError('That submission no longer exists.');
		}
		return submission;
	}

	public async submitSession(
		id: string,
		userId: string,
		version: number,
		memberRoleIds: readonly string[] | null
	) {
		return this.withUserLock(userId, async (database) => {
			const [existing] = await database
				.select()
				.from(submissions)
				.where(and(eq(submissions.sessionId, id), eq(submissions.userId, userId)));
			if (existing) {
				return existing;
			}
			const session = await this.assertCurrentSession(
				database,
				id,
				userId,
				version,
				memberRoleIds
			);
			if (
				session.status !== 'confirm' ||
				session.snapshot.questions.some(
					(question, questionIndex) =>
						question.required && session.answers[questionIndex] == null
				)
			) {
				throw new FormError('Finish answering and review your answers before submitting.');
			}
			const form = await this.findForm(session.formId, database);
			const submissionId = randomUUID();
			const [submission] = await database
				.insert(submissions)
				.values({
					id: submissionId,
					sessionId: id,
					userId: userId,
					guildId: session.guildId,
					formId: session.formId,
					snapshot: {
						...session.snapshot,
						reviewChannelId: form.published!.reviewChannelId
					},
					answers: session.answers
				})
				.returning();
			await database
				.update(sessions)
				.set({
					status: 'submitted',
					version: session.version + 1
				})
				.where(eq(sessions.id, id));
			await database.update(files).set({ expiresAt: null }).where(eq(files.sessionId, id));
			await this.enqueueDelivery(database, 'review', submissionId);
			await this.recordAuditEvent(
				database,
				session.guildId,
				userId,
				'submission.submit',
				submissionId
			);
			return submission!;
		});
	}

	public async recordDecision(
		id: string,
		reviewerId: string,
		threadId: string,
		decision: 'accepted' | 'rejected',
		reason: string,
		identity: StaffIdentity = {
			userId: reviewerId,
			roleIds: [],
			manageServer: false,
			administrator: false
		}
	) {
		await this.database.transaction(async (database) => {
			const [session] = await database
				.select()
				.from(submissions)
				.where(eq(submissions.id, id))
				.for('update');
			if (!session || session.threadId !== threadId) {
				throw new FormError('These buttons belong to a different submission thread.');
			}
			if (identity.userId !== reviewerId) {
				throw new FormError('This action was started by a different staff member.');
			}

			await new StaffPermissions(this.database).assertAllowed(
				session.guildId,
				'submissions.decide',
				identity,
				database
			);
			if (session.status !== 'pending') {
				throw new FormError(`This submission was already ${session.status}.`);
			}
			await database
				.update(submissions)
				.set({
					status: decision,
					reviewerId: reviewerId,
					reason: reason.slice(0, 1000)
				})
				.where(eq(submissions.id, id));
			await this.recordAuditEvent(
				database,
				session.guildId,
				reviewerId,
				`submission.${decision}`,
				id
			);
			await this.enqueueDelivery(database, 'receipt', id);
			await this.enqueueDelivery(database, 'close', id);
		});
	}

	public async claimDeliveryJob() {
		return this.database.transaction(async (database) => {
			const [job] = await database
				.select()
				.from(jobs)
				.where(
					and(
						lte(jobs.nextAttemptAt, new Date()),
						or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, new Date()))
					)
				)
				.orderBy(jobs.nextAttemptAt)
				.for('update', { skipLocked: true })
				.limit(1);
			if (!job) {
				return null;
			}
			await database
				.update(jobs)
				.set({
					leaseUntil: new Date(Date.now() + 300000),
					attempts: job.attempts + 1
				})
				.where(eq(jobs.id, job.id));
			return job;
		});
	}
}
