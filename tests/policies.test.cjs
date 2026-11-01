process.env.BotName = 'Policy Tests';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { drizzle } = require('drizzle-orm/pglite');
const { migrate } = require('drizzle-orm/pglite/migrator');
const { Collection } = require('discord.js');
const { eq } = require('drizzle-orm');
const schema = require('../dist/database/schema');
const { FormService } = require('../dist/modules/forms/services/form-service');
const { StaffPermissions } = require('../dist/modules/forms/services/staff-permissions');
const { RateLimits, RateLimitError } = require('../dist/modules/forms/services/rate-limits');
const { FormBrowsing, pagination } = require('../dist/modules/forms/discord/browsing');
const { formQuestionSchema } = require('../dist/modules/forms/domain/schemas');
let postgres, database, formService, permissions, close;
const guildId = String(BigInt(Date.now()) * 100000n);
const channelId = '12345678901234568';
const actorId = '12345678901234569';
const staffRoleId = '12345678901234570';
const manager = { userId: actorId, roleIds: [], manageServer: true, administrator: false };
const ordinary = { userId: actorId, roleIds: [], manageServer: false, administrator: false };

before(async () => {
	if (process.env.ZORAFORMS_TEST_DATABASE_URL) {
		const url = new URL(process.env.ZORAFORMS_TEST_DATABASE_URL);
		assert.match(url.pathname, /_test$/);
		const { createPostgresConnection } = require('../dist/database/database');
		const connection = createPostgresConnection(url.toString());
		await connection.applyMigrations();
		database = connection.database;
		close = connection.close;
	} else {
		postgres = new PGlite();
		database = drizzle(postgres, { schema });
		await migrate(database, { migrationsFolder: './drizzle' });
		close = () => postgres.close();
	}
	formService = new FormService(database);
	permissions = new StaffPermissions(database);
});
after(async () => close());

async function fixture(overrides = {}) {
	return formService.createForm(guildId, actorId, {
		name: 'Policy form',
		reviewChannelId: channelId,
		questions: [
			formQuestionSchema.parse({ id: randomUUID(), type: 'text', prompt: 'Question' })
		],
		...overrides
	});
}

function browserContext() {
	let visible = true;
	const guild = {
		id: guildId,
		members: {
			fetch: async () => ({
				roles: { cache: new Collection([[staffRoleId, {}]]) },
				permissions: { has: () => false }
			})
		}
	};
	const client = {
		channels: { fetch: async () => ({ permissionsFor: () => ({ has: () => visible }) }) }
	};
	return {
		guild,
		client,
		hide: () => {
			visible = false;
		}
	};
}

function text(message) {
	return message.components.map((component) => JSON.stringify(component.toJSON())).join('');
}

test('Manage Server and Administrator have default access without grants', async () => {
	assert.equal(await permissions.allowed(guildId, 'forms.create', manager), true);
	assert.equal(
		await permissions.allowed(guildId, 'submissions.decide', {
			...ordinary,
			administrator: true
		}),
		true
	);
	assert.equal(await permissions.allowed('another-guild', 'forms.create', ordinary), false);
});

test('user and role grants are independent, scoped to a server and revocable', async () => {
	const isolatedGuild = randomUUID();
	await permissions.configure(isolatedGuild, manager, 'submissions.reply', 'user', actorId, true);
	assert.equal(await permissions.allowed(isolatedGuild, 'submissions.reply', ordinary), true);
	assert.equal(await permissions.allowed(isolatedGuild, 'submissions.decide', ordinary), false);
	assert.equal(await permissions.allowed(guildId, 'submissions.reply', ordinary), false);
	await permissions.configure(isolatedGuild, manager, 'forms.edit', 'role', staffRoleId, true);
	assert.equal(
		await permissions.allowed(isolatedGuild, 'forms.edit', {
			...ordinary,
			roleIds: [staffRoleId]
		}),
		true
	);
	assert.equal(await permissions.allowed(isolatedGuild, 'forms.edit', ordinary), false);
	await permissions.configure(
		isolatedGuild,
		manager,
		'submissions.reply',
		'user',
		actorId,
		false
	);
	assert.equal(await permissions.allowed(isolatedGuild, 'submissions.reply', ordinary), false);
	await assert.rejects(
		permissions.configure(isolatedGuild, ordinary, 'forms.create', 'user', actorId, true),
		/Only members with Manage Server/
	);
});

test('form blacklists accept both users and roles and override allow lists', async () => {
	const form = await fixture({ allowRoles: [staffRoleId] });
	await formService.publishForm(form.id, guildId, actorId, form.data.revision);
	const userId = randomUUID();
	await formService.changeFormBlacklist(form.id, guildId, actorId, 'role', {
		added: [staffRoleId],
		removed: []
	});
	await assert.rejects(formService.startSession(form.id, userId, [staffRoleId]), /not available/);
	await formService.changeFormBlacklist(form.id, guildId, actorId, 'role', {
		added: [],
		removed: [staffRoleId]
	});
	await formService.changeFormBlacklist(form.id, guildId, actorId, 'user', {
		added: [userId],
		removed: []
	});
	await assert.rejects(formService.startSession(form.id, userId, [staffRoleId]), /not available/);
	await formService.changeFormBlacklist(form.id, guildId, actorId, 'user', {
		added: [],
		removed: [userId]
	});
	assert.ok(await formService.startSession(form.id, userId, [staffRoleId]));
});

test('rate limits survive a new worker, suppress repeated notices and reset after the window', async () => {
	let now = 100000;
	const userId = randomUUID();
	const limiter = new RateLimits(database, () => now);
	for (let request = 0; request < 8; request++) await limiter.enforce(userId, 'message');
	await assert.rejects(
		limiter.enforce(userId, 'message'),
		(error) => error instanceof RateLimitError && error.shouldNotify
	);
	await assert.rejects(
		new RateLimits(database, () => now).enforce(userId, 'message'),
		(error) => error instanceof RateLimitError && !error.shouldNotify
	);
	now += 10001;
	await limiter.enforce(userId, 'message');
});

test('concurrent workers share the rate limit and changing entry points cannot bypass the global cap', async () => {
	const userId = randomUUID();
	const timestamp = Date.now();
	const workers = [
		new RateLimits(database, () => timestamp),
		new RateLimits(database, () => timestamp)
	];
	const outcomes = await Promise.allSettled(
		Array.from({ length: 12 }, (_, index) => workers[index % 2].enforce(userId, 'message'))
	);
	assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 8);
	const anotherUser = randomUUID();
	for (let request = 0; request < 8; request++) await workers[0].enforce(anotherUser, 'message');
	for (let request = 0; request < 6; request++) await workers[0].enforce(anotherUser, 'command');
	for (let request = 0; request < 6; request++)
		await workers[0].enforce(anotherUser, 'interaction');
	await assert.rejects(workers[1].enforce(anotherUser, 'interaction'), RateLimitError);
});

test('staff form browsing reaches every page and the final form can be selected', async () => {
	const context = browserContext();
	const browser = new FormBrowsing(formService, permissions, context.client);
	await permissions.configure(guildId, manager, 'forms.edit', 'role', staffRoleId, true);
	for (let index = 0; index < 35; index++) await fixture({ name: `Listed form ${index}` });
	const seen = new Set();
	for (let page = 0; page < 4; page++) {
		const content = await browser.forms(context.guild, actorId, page);
		const components = content.components[0].toJSON().components;
		const select = components.find(
			(component) => component.type === 1 && component.components[0].type === 3
		);
		for (const option of select?.components[0].options ?? []) seen.add(option.value);
	}
	assert.doesNotMatch(text(await browser.forms(context.guild, actorId)), /ID:/);
	const allForms = await formService.listForms(guildId);
	assert.equal(seen.size, allForms.length);
	assert.deepEqual(pagination(NaN, 35), { page: 0, pages: 4, offset: 0 });
	assert.equal(pagination(9999, 35).page, 3);
});

test('submission browsing is paginated and reading depends on channel access rather than action grants', async () => {
	const context = browserContext();
	const browser = new FormBrowsing(formService, permissions, context.client);
	const form = await fixture();
	for (let index = 0; index < 27; index++) {
		const sessionId = randomUUID();
		await database.insert(schema.sessions).values({
			id: sessionId,
			userId: actorId,
			guildId,
			formId: form.id,
			snapshot: form.data,
			status: 'submitted'
		});
		await database.insert(schema.submissions).values({
			sessionId,
			userId: actorId,
			guildId,
			formId: form.id,
			snapshot: form.data,
			answers: [],
			expiresAt: new Date(Date.now() + 86400000)
		});
	}
	const lastPage = await browser.submissions(context.guild, form.id, actorId, 2);
	assert.match(text(lastPage), /Page 3 of 3/);
	assert.match(text(await browser.applicantSubmissions(actorId, 2)), /Page 3 of 3/);
	assert.doesNotMatch(text(lastPage), /zf:b:repair/);
	assert.match(text(lastPage), new RegExp(`<@${actorId}>`));
	assert.ok(text(lastPage).includes(`\`${actorId}\``), 'the submitter ID is listed');
	await permissions.configure(guildId, manager, 'submissions.repair', 'role', staffRoleId, true);
	assert.match(
		text(await browser.submissions(context.guild, form.id, actorId, 2)),
		/zf:b:repair/
	);
	await permissions.configure(guildId, manager, 'submissions.repair', 'role', staffRoleId, false);
	assert.match(text(await browser.submissionForms(context.guild, actorId)), /zf:b:readopen/);
	context.hide();
	assert.match(
		text(await browser.submissionForms(context.guild, actorId)),
		/No forms send submissions/
	);
	await assert.rejects(
		browser.submissions(context.guild, form.id, actorId),
		/access to the submission channel/
	);
});

test('preview pagination exposes all questions and long choice lists without exceeding the component text budget', async () => {
	const context = browserContext();
	const browser = new FormBrowsing(formService, permissions, context.client);
	const questions = Array.from({ length: 25 }, (_, index) =>
		formQuestionSchema.parse({
			id: randomUUID(),
			type: 'choice',
			prompt: `Question ${index + 1}`,
			options: Array.from({ length: 25 }, (_, choice) => `${choice}: ${'*'.repeat(95)}`)
		})
	);
	const form = await fixture({ description: '*'.repeat(500), questions });
	let sawFinalQuestion = false;
	let page = 0;
	while (page < 100) {
		const message = await browser.preview(form, actorId, page);
		const serialized = text(message);
		if (serialized.includes('Question 25')) sawFinalQuestion = true;
		const content = message.components[0]
			.toJSON()
			.components.find((component) => component.type === 10).content;
		assert.ok(content.length <= 4000);
		const navigation = message.components[0]
			.toJSON()
			.components.find((component) => component.type === 1);
		for (const control of navigation.components) assert.ok(control.custom_id.length <= 100);
		page++;
		if (navigation.components[1].disabled) break;
	}
	assert.equal(sawFinalQuestion, true);
	assert.ok(page > 25);
});

test('reply permission does not allow decisions and revoked roles lose access immediately', async () => {
	const form = await fixture();
	const applicantId = randomUUID();
	const sessionId = randomUUID();
	await database.insert(schema.sessions).values({
		id: sessionId,
		userId: applicantId,
		guildId,
		formId: form.id,
		snapshot: form.data,
		status: 'submitted'
	});
	const [submission] = await database
		.insert(schema.submissions)
		.values({
			sessionId,
			userId: applicantId,
			guildId,
			formId: form.id,
			snapshot: form.data,
			answers: [],
			threadId: randomUUID(),
			expiresAt: new Date(Date.now() + 86400000)
		})
		.returning();
	const identity = { ...ordinary, roleIds: [staffRoleId] };
	await permissions.configure(guildId, manager, 'submissions.reply', 'role', staffRoleId, true);
	await assert.rejects(
		formService.recordDecision(
			submission.id,
			actorId,
			submission.threadId,
			'accepted',
			'Yes',
			identity
		),
		/do not have permission/
	);
	const replyInteractionId = randomUUID();
	const replyId = await formService.replyToSubmission(
		submission.id,
		identity,
		submission.threadId,
		'Thanks for applying.',
		replyInteractionId
	);
	assert.ok(replyId);
	assert.equal(
		await formService.replyToSubmission(
			submission.id,
			identity,
			submission.threadId,
			'Thanks for applying.',
			replyInteractionId
		),
		replyId
	);
	assert.equal(
		(
			await database
				.select()
				.from(schema.submissionReplies)
				.where(eq(schema.submissionReplies.id, replyId))
		).length,
		1
	);
	await permissions.configure(guildId, manager, 'submissions.reply', 'role', staffRoleId, false);
	await assert.rejects(
		formService.replyToSubmission(
			submission.id,
			identity,
			submission.threadId,
			'Another update'
		),
		/do not have permission/
	);
});
