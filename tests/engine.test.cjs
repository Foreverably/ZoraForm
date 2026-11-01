const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { drizzle } = require('drizzle-orm/pglite');
const { migrate } = require('drizzle-orm/pglite/migrator');
const { eq } = require('drizzle-orm');
const schema = require('../dist/database/schema');
const { FormService } = require('../dist/modules/forms/services/form-service');
const {
	assertFormAccess,
	describeNumberLimits,
	numberLimits,
	validateQuestionAnswer
} = require('../dist/modules/forms/domain/rules');
const { formQuestionSchema } = require('../dist/modules/forms/domain/schemas');
const { createPostgresConnection } = require('../dist/database/database');
let formService, database, close;
let testOffset = BigInt(Date.now()) * 100000n;
const event = (id) => String(testOffset + BigInt(id));
beforeEach(() => {
	testOffset += 1000n;
});
const reviewer = '12345678901234567';

before(async () => {
	if (process.env.ZORAFORMS_TEST_DATABASE_URL) {
		const url = new URL(process.env.ZORAFORMS_TEST_DATABASE_URL);
		assert.match(
			url.pathname,
			/_test$/,
			'Integration tests require a dedicated database ending in _test'
		);
		const connection = createPostgresConnection(url.toString());
		await connection.applyMigrations();
		database = connection.database;
		close = connection.close;
	} else {
		const client = new PGlite();
		database = drizzle(client, { schema });
		await migrate(database, { migrationsFolder: './drizzle' });
		close = () => client.close();
	}
	formService = new FormService(database);
});
after(async () => {
	if (close) await close();
});
async function fixture(overrides = {}) {
	const user = randomUUID();
	const question = formQuestionSchema.parse({
		id: randomUUID(),
		type: 'text',
		prompt: 'Why join?',
		min: 3,
		max: 100
	});
	const form = await formService.createForm('12345678901234568', reviewer, {
		name: 'Staff application',
		reviewChannelId: '12345678901234569',
		questions: [question],
		...overrides
	});
	await database
		.insert(schema.staffGrants)
		.values({
			guildId: form.guildId,
			capability: 'submissions.decide',
			subjectType: 'user',
			subjectId: reviewer
		})
		.onConflictDoNothing();
	await formService.publishForm(form.id, form.guildId, reviewer, form.data.revision);
	return { user, form: await formService.findForm(form.id), question };
}
async function delivered(session, prompt = event('100')) {
	await database
		.update(schema.sessions)
		.set({
			status: session.position >= session.snapshot.questions.length ? 'confirm' : 'answer',
			promptId: prompt
		})
		.where(eq(schema.sessions.id, session.id));
	return formService.findSession(session.id);
}
async function completed(fixtureData) {
	let session = await formService.startSession(fixtureData.form.id, fixtureData.user, []);
	session = await delivered(session);
	await formService.saveAnswer(
		session.id,
		fixtureData.user,
		session.version,
		[],
		event('200'),
		'Because I enjoy helping.'
	);
	return delivered(await formService.findSession(session.id), event('300'));
}

test('restart restores answers, question revision and confirmation state', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	const recovered = await new FormService(database).findActiveSession(fixtureData.user);
	assert.equal(recovered.id, session.id);
	assert.equal(recovered.status, 'confirm');
	assert.deepEqual(recovered.answers, ['Because I enjoy helping.']);
	await formService.editFormDraft(
		fixtureData.form.id,
		fixtureData.form.guildId,
		reviewer,
		(data) => ({
			...data,
			questions: []
		})
	);
	assert.equal((await formService.findSession(session.id)).snapshot.questions.length, 1);
});
test('first greeting cannot be stored while a prompt is undelivered', async () => {
	const fixtureData = await fixture();
	const session = await formService.startSession(fixtureData.form.id, fixtureData.user, []);
	await assert.rejects(
		formService.saveAnswer(session.id, fixtureData.user, 0, [], event('200'), 'hello'),
		/latest question/
	);
	assert.deepEqual((await formService.findSession(session.id)).answers, []);
});
test('duplicate events are idempotent and late replies cannot answer the next question', async () => {
	const fixtureData = await fixture();
	let session = await delivered(
		await formService.startSession(fixtureData.form.id, fixtureData.user, [])
	);
	await formService.saveAnswer(
		session.id,
		fixtureData.user,
		session.version,
		[],
		event('200'),
		'valid'
	);
	await formService.saveAnswer(
		session.id,
		fixtureData.user,
		session.version,
		[],
		event('200'),
		'valid'
	);
	await assert.rejects(
		formService.saveAnswer(
			session.id,
			fixtureData.user,
			session.version,
			[],
			event('201'),
			'second'
		),
		/out of date/
	);
	session = await formService.findSession(session.id);
	assert.equal(session.position, 1);
	assert.equal(session.answers.length, 1);
});
test('responses to an old prompt and malformed numbers are rejected', async () => {
	const fixtureData = await fixture();
	const session = await delivered(
		await formService.startSession(fixtureData.form.id, fixtureData.user, [])
	);
	await assert.rejects(
		formService.saveAnswer(
			session.id,
			fixtureData.user,
			0,
			[],
			event('200'),
			'valid',
			[],
			event('99')
		),
		/latest question/
	);
	const number = formQuestionSchema.parse({
		id: randomUUID(),
		type: 'number',
		prompt: 'Age',
		min: 18,
		max: 100
	});
	assert.throws(() => validateQuestionAnswer(number, '18 years'));
	assert.throws(() => validateQuestionAnswer(number, '17'), /between 18 and 100/);
	assert.equal(validateQuestionAnswer(number, '18.5'), 18.5);
	assert.equal(validateQuestionAnswer(number, '24'), 24);
});

test('number questions have no limits by default and old stored defaults count as no limit', () => {
	const unlimited = formQuestionSchema.parse({ id: randomUUID(), type: 'number', prompt: 'Age' });
	assert.equal(unlimited.min, null);
	assert.equal(unlimited.max, null);
	assert.equal(validateQuestionAnswer(unlimited, '-5000000000'), -5000000000);
	assert.throws(() => validateQuestionAnswer(unlimited, 'many'), /such as 25/);
	const savedBeforeLimitsWereOptional = { ...unlimited, min: -1e9, max: 1e9, integer: true };
	assert.deepEqual(numberLimits(savedBeforeLimitsWereOptional), { min: null, max: null });
	assert.equal(describeNumberLimits(savedBeforeLimitsWereOptional), null);
	assert.equal(validateQuestionAnswer(savedBeforeLimitsWereOptional, '2.5'), 2.5);
	assert.equal(describeNumberLimits({ ...unlimited, min: 18 }), 'of at least 18');
	assert.equal(describeNumberLimits({ ...unlimited, max: 99 }), 'of at most 99');
	assert.throws(
		() =>
			formQuestionSchema.parse({
				id: randomUUID(),
				type: 'number',
				prompt: 'Age',
				min: 9,
				max: 2
			}),
		/Minimum must not exceed maximum/
	);
});
test('denials beat allow-lists, required roles and membership are enforced', async () => {
	const fixtureData = await fixture({
		allowRoles: ['12345678901234570'],
		denyRoles: ['12345678901234571'],
		requiredRoles: ['12345678901234572']
	});
	assert.throws(() => assertFormAccess(fixtureData.form, fixtureData.user, null));
	assert.throws(() =>
		assertFormAccess(fixtureData.form, fixtureData.user, ['12345678901234570'])
	);
	assert.throws(() =>
		assertFormAccess(fixtureData.form, fixtureData.user, [
			'12345678901234570',
			'12345678901234571',
			'12345678901234572'
		])
	);
	assert.doesNotThrow(() =>
		assertFormAccess(fixtureData.form, fixtureData.user, [
			'12345678901234570',
			'12345678901234572'
		])
	);
});
test('blacklist added mid-session prevents answers but permits cancellation', async () => {
	const fixtureData = await fixture();
	const session = await delivered(
		await formService.startSession(fixtureData.form.id, fixtureData.user, [])
	);
	await formService.changeFormBlacklist(
		fixtureData.form.id,
		fixtureData.form.guildId,
		reviewer,
		'user',
		{ added: [fixtureData.user], removed: [] }
	);
	await assert.rejects(
		formService.saveAnswer(session.id, fixtureData.user, 0, [], event('200'), 'valid'),
		/not available/
	);
	await formService.navigateSession(session.id, fixtureData.user, 0, null, 'cancel');
	assert.equal(await formService.findActiveSession(fixtureData.user), null);
});
test('one unfinished conversation per user includes paused sessions', async () => {
	const fixtureData = await fixture();
	const session = await formService.startSession(fixtureData.form.id, fixtureData.user, []);
	await formService.navigateSession(session.id, fixtureData.user, 0, [], 'pause');
	await assert.rejects(
		formService.startSession(fixtureData.form.id, fixtureData.user, []),
		/already have/
	);
	await formService.navigateSession(session.id, fixtureData.user, 1, [], 'resume');
	assert.equal((await formService.findSession(session.id)).status, 'prompt');
});
test('double submit produces one immutable submission and one review job', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	const first = await formService.submitSession(
		session.id,
		fixtureData.user,
		session.version,
		[]
	);
	const again = await formService.submitSession(
		session.id,
		fixtureData.user,
		session.version,
		[]
	);
	assert.equal(first.id, again.id);
	const reviewJobs = await database
		.select()
		.from(schema.jobs)
		.where(eq(schema.jobs.dedupe, `review:${first.id}:0`));
	assert.equal(reviewJobs.length, 1);
	assert.equal(await formService.findActiveSession(fixtureData.user), null);
	await assert.rejects(
		formService.startSession(fixtureData.form.id, fixtureData.user, []),
		/still waiting for staff review/
	);
});
test('review decisions validate reviewer and thread; final state cannot be overwritten', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	const submission = await formService.submitSession(
		session.id,
		fixtureData.user,
		session.version,
		[]
	);
	await database
		.update(schema.submissions)
		.set({ threadId: event('500') })
		.where(eq(schema.submissions.id, submission.id));
	await assert.rejects(
		formService.recordDecision(submission.id, reviewer, 'wrong-thread', 'accepted', 'ok'),
		/does not belong/
	);
	await assert.rejects(
		formService.recordDecision(submission.id, 'other', event('500'), 'accepted', 'ok'),
		/do not have permission/
	);
	await formService.recordDecision(submission.id, reviewer, event('500'), 'accepted', 'Welcome');
	await assert.rejects(
		formService.recordDecision(submission.id, reviewer, event('500'), 'rejected', 'changed'),
		/already accepted/
	);
	assert.equal((await formService.findSubmission(submission.id)).reason, 'Welcome');
});
test('form archival hides it and prevents completing an existing draft', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	await formService.archiveForm(fixtureData.form.id, fixtureData.form.guildId, reviewer);
	await assert.rejects(
		formService.submitSession(session.id, fixtureData.user, session.version, []),
		/not available/
	);
	assert.equal(
		(await formService.listForms()).some((form) => form.id === fixtureData.form.id),
		false
	);
});
test('failed answer rolls back without consuming input or advancing', async () => {
	const fixtureData = await fixture();
	const session = await delivered(
		await formService.startSession(fixtureData.form.id, fixtureData.user, [])
	);
	await assert.rejects(
		formService.saveAnswer(session.id, fixtureData.user, 0, [], event('200'), 'x'),
		/characters/
	);
	await formService.saveAnswer(session.id, fixtureData.user, 0, [], event('200'), 'fixed');
	assert.equal((await formService.findSession(session.id)).position, 1);
});
test('once-ever policy still applies after a rejection', async () => {
	const fixtureData = await fixture({ totalLimit: 1 });
	const session = await completed(fixtureData);
	const submission = await formService.submitSession(
		session.id,
		fixtureData.user,
		session.version,
		[]
	);
	await database
		.update(schema.submissions)
		.set({ status: 'rejected' })
		.where(eq(schema.submissions.id, submission.id));
	await assert.rejects(
		formService.startSession(fixtureData.form.id, fixtureData.user, []),
		/reached the submission limit/
	);
});

test('simultaneous starts create one conversation across workers', async () => {
	const fixtureData = await fixture();
	const outcomes = await Promise.allSettled([
		formService.startSession(fixtureData.form.id, fixtureData.user, []),
		new FormService(database).startSession(fixtureData.form.id, fixtureData.user, [])
	]);
	assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
	assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
});

test('simultaneous submissions and competing decisions have one durable result', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	const competingService = new FormService(database);
	const [first, duplicate] = await Promise.all([
		formService.submitSession(session.id, fixtureData.user, session.version, []),
		competingService.submitSession(session.id, fixtureData.user, session.version, [])
	]);
	assert.equal(first.id, duplicate.id);
	await database
		.update(schema.submissions)
		.set({ threadId: event('500') })
		.where(eq(schema.submissions.id, first.id));
	const decisions = await Promise.allSettled([
		formService.recordDecision(first.id, reviewer, event('500'), 'accepted', 'First'),
		competingService.recordDecision(first.id, reviewer, event('500'), 'rejected', 'Second')
	]);
	assert.equal(decisions.filter((outcome) => outcome.status === 'fulfilled').length, 1);
});

test('confirmation can reopen a selected answer without mutating a submitted snapshot', async () => {
	const fixtureData = await fixture();
	const session = await completed(fixtureData);
	await formService.editAnswerPosition(session.id, fixtureData.user, session.version, [], 0);
	const editing = await formService.findSession(session.id);
	assert.equal(editing.position, 0);
	assert.equal(editing.status, 'prompt');
	assert.equal(editing.answers[0], 'Because I enjoy helping.');
	await assert.rejects(
		formService.editAnswerPosition(session.id, fixtureData.user, session.version, [], 0),
		/out of date/
	);
});
