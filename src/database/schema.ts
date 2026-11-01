import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	jsonb,
	boolean,
	integer,
	timestamp,
	uniqueIndex,
	index,
	primaryKey
} from 'drizzle-orm/pg-core';
import type {
	FormConfiguration,
	QuestionAnswer,
	QuestionnaireSession,
	DeliveryJob
} from '../modules/forms/model';

export const forms = pgTable(
	'forms',
	{
		id: uuid()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text('guild_id').notNull(),
		data: jsonb().$type<FormConfiguration>().notNull(),
		published: jsonb().$type<FormConfiguration>(),
		archived: boolean().notNull().default(false)
	},
	(table) => [index('forms_guild').on(table.guildId)]
);

export const userLocks = pgTable('user_locks', { userId: text('user_id').primaryKey() });

export const guildBlacklist = pgTable(
	'guild_blacklist',
	{
		guildId: text('guild_id').notNull(),
		userId: text('user_id').notNull()
	},
	(table) => [primaryKey({ columns: [table.guildId, table.userId] })]
);

export const sessions = pgTable(
	'sessions',
	{
		id: uuid()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id').notNull(),
		guildId: text('guild_id').notNull(),
		formId: uuid('form_id')
			.notNull()
			.references(() => forms.id),
		snapshot: jsonb().$type<FormConfiguration>().notNull(),
		answers: jsonb().$type<QuestionAnswer[]>().notNull().default([]),
		position: integer().notNull().default(0),
		status: text().$type<QuestionnaireSession['status']>().notNull().default('prompt'),
		version: integer().notNull().default(0),
		promptId: text('prompt_id'),
		expiresAt: timestamp('expires_at', { withTimezone: true })
			.notNull()
			.$defaultFn(() => new Date(Date.now() + 7 * 86400000))
	},
	(table) => [
		uniqueIndex('one_conversation')
			.on(table.userId)
			.where(sql`${table.status} in ('prompt','answer','confirm','paused')`)
	]
);

export const submissions = pgTable(
	'submissions',
	{
		id: uuid()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: uuid('session_id')
			.notNull()
			.unique()
			.references(() => sessions.id),
		userId: text('user_id').notNull(),
		guildId: text('guild_id').notNull(),
		formId: uuid('form_id')
			.notNull()
			.references(() => forms.id),
		snapshot: jsonb().$type<FormConfiguration>().notNull(),
		answers: jsonb().$type<QuestionAnswer[]>().notNull(),
		status: text().$type<'pending' | 'accepted' | 'rejected'>().notNull().default('pending'),
		threadId: text('thread_id').unique(),
		reviewerId: text('reviewer_id'),
		reason: text(),
		archived: boolean().notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		deliveryState: text('delivery_state').notNull().default('queued')
	},
	(table) => [index('submissions_policy').on(table.formId, table.userId, table.createdAt)]
);

export const processedInputs = pgTable('processed_inputs', {
	id: text().primaryKey(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const jobs = pgTable('jobs', {
	id: uuid()
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text().$type<DeliveryJob['kind']>().notNull(),
	payload: jsonb().$type<DeliveryJob['payload']>().notNull(),
	dedupe: text().notNull().unique(),
	attempts: integer().notNull().default(0),
	nextAttemptAt: timestamp('next_at', { withTimezone: true }).notNull().defaultNow(),
	leaseUntil: timestamp('lease_until', { withTimezone: true }),
	errorCode: text('error_code')
});

export const auditEvents = pgTable('audit_events', {
	id: uuid()
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text('guild_id').notNull(),
	actorId: text('actor_id').notNull(),
	action: text().notNull(),
	targetId: text('target_id').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const files = pgTable('files', {
	key: text().primaryKey(),
	sessionId: uuid('session_id')
		.notNull()
		.references(() => sessions.id),
	name: text().notNull(),
	size: integer().notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date(Date.now() + 7 * 86400000))
});
