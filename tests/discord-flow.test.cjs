process.env.BotName = 'Test Forms';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { drizzle } = require('drizzle-orm/pglite');
const { migrate } = require('drizzle-orm/pglite/migrator');
const { Collection, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { eq } = require('drizzle-orm');
const schema = require('../dist/database/schema');
const { FormService } = require('../dist/modules/forms/services/form-service');
const { ApplicantFlow } = require('../dist/modules/forms/discord/applicant-flow');
const { DiscordDelivery } = require('../dist/modules/forms/discord/delivery-worker');
const { AttachmentTransfer } = require('../dist/modules/forms/services/attachment-transfer');
const { FormBuilder } = require('../dist/modules/forms/discord/form-builder');
const { formQuestionSchema } = require('../dist/modules/forms/domain/schemas');
const {
	prompt,
	summary,
	managePanel,
	answerPages
} = require('../dist/modules/forms/discord/components');
let database, formService, postgres;
const guildId = '12345678901234567';
const reviewerId = '12345678901234568';
const reviewChannelId = '12345678901234569';

before(async () => {
	postgres = new PGlite();
	database = drizzle(postgres, { schema });
	await migrate(database, { migrationsFolder: './drizzle' });
	formService = new FormService(database);
});
after(async () => {
	await postgres.close();
});

function mockDiscord() {
	let nextId = BigInt(Date.now()) * 100000n;
	const channels = new Map();
	const directMessages = new Map();
	const reviewThreads = new Collection();
	const operations = [];
	const reviewMessages = new Collection();
	const sentNonces = new Map();
	let loseCreationResponse = false;
	let loseCardResponse = false;
	const id = () => String(++nextId);
	const messageChannel = () => {
		const messages = new Collection();
		const channelId = id();
		const channel = {
			id: channelId,
			isDMBased: () => true,
			isSendable: () => true,
			messages: {
				store: messages,
				fetch: async (request) =>
					typeof request === 'string'
						? messages.get(request)
						: request?.message
							? messages.get(request.message)
							: messages
			},
			send: async (payload) => {
				const components = payload.components?.map((component) => component.toJSON()) ?? [];
				const message = { id: id(), author: { id: 'bot' }, components, payload };
				messages.set(message.id, message);
				return message;
			}
		};
		channels.set(channelId, channel);
		return channel;
	};
	const guild = {
		id: guildId,
		name: 'Test community',
		roles: { everyone: { id: guildId }, cache: new Collection(), fetch: async () => undefined },
		members: {
			fetchMe: async () => ({ id: 'bot' }),
			fetch: async ({ user }) => ({
				id: user,
				guild: { id: guildId },
				displayName: 'Server Name',
				nickname: 'Server Name',
				joinedTimestamp: 1700000000000,
				roles: {
					cache: new Collection([
						[guildId, { position: 0 }],
						['12345678901234111', { position: 1 }]
					])
				},
				permissions: { has: () => true }
			})
		}
	};
	const reviewChannel = {
		id: reviewChannelId,
		type: ChannelType.GuildText,
		guildId,
		guild,
		permissionsFor: (member) => ({
			has: (permissions) =>
				!(member.id === guildId && permissions === PermissionFlagsBits.ViewChannel)
		}),
		messages: {
			fetch: async (messageId) => {
				if (!reviewMessages.has(messageId)) {
					throw Object.assign(new Error('Unknown Message'), { code: 10008 });
				}
				return reviewMessages.get(messageId);
			},
			delete: async (messageId) => reviewMessages.delete(messageId)
		},
		send: async (payload) => {
			if (payload.enforceNonce && sentNonces.has(payload.nonce)) {
				return sentNonces.get(payload.nonce);
			}
			const messageId = id();
			const card = {
				id: messageId,
				author: { id: 'bot' },
				components: payload.components.map((component) => component.toJSON()),
				startThread: async (configuration) => {
					operations.push('create-thread');
					const thread = {
						...messageChannel(),
						id: messageId,
						name: configuration.name,
						type: ChannelType.PublicThread,
						parentId: reviewChannelId,
						archived: false,
						locked: false,
						members: { add: async (memberId) => operations.push(`invite:${memberId}`) },
						setArchived: async function (value) {
							this.archived = value;
						},
						setLocked: async function (value) {
							this.locked = value;
						},
						delete: async function () {
							channels.delete(this.id);
							reviewThreads.delete(this.id);
						}
					};
					reviewThreads.set(thread.id, thread);
					channels.set(thread.id, thread);
					if (loseCreationResponse) {
						loseCreationResponse = false;
						throw new Error('Simulated lost response after Discord created the thread');
					}
					return thread;
				}
			};
			operations.push('post-card');
			reviewMessages.set(messageId, card);
			sentNonces.set(payload.nonce, card);
			if (loseCardResponse) {
				loseCardResponse = false;
				throw new Error('Simulated lost response after Discord posted the card');
			}
			return card;
		}
	};
	channels.set(reviewChannelId, reviewChannel);
	const client = {
		user: { id: 'bot' },
		isReady: () => true,
		guilds: { cache: new Collection([[guildId, guild]]) },
		channels: { fetch: async (channelId) => channels.get(channelId) ?? null },
		users: {
			fetch: async (userId) => ({
				id: userId,
				username: 'tester',
				globalName: 'Test User',
				displayName: 'Test User',
				accentColor: 0x123456,
				createdTimestamp: 1600000000000,
				bannerURL: () => 'https://cdn.discordapp.com/banners/1/banner.png',
				displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/avatar.png',
				createDM: async () => {
					if (!directMessages.has(userId)) directMessages.set(userId, messageChannel());
					return directMessages.get(userId);
				}
			})
		}
	};
	return {
		client,
		id,
		operations,
		channels,
		reviewThreads,
		reviewMessages,
		directMessages,
		loseNextCreationResponse: () => {
			loseCreationResponse = true;
		},
		loseNextCardResponse: () => {
			loseCardResponse = true;
		}
	};
}

async function setupFlow() {
	const discord = mockDiscord();
	const attachments = new AttachmentTransfer(database, discord.client);
	const delivery = new DiscordDelivery(discord.client, formService, attachments);
	const applicant = new ApplicantFlow(discord.client, formService, attachments);
	const userId = randomUUID();
	const question = formQuestionSchema.parse({
		id: randomUUID(),
		type: 'text',
		prompt: 'Why join?',
		min: 3
	});
	const form = await formService.createForm(guildId, reviewerId, {
		name: 'Test application',
		reviewChannelId,
		questions: [question]
	});
	await database
		.insert(schema.staffGrants)
		.values({
			guildId,
			capability: 'submissions.decide',
			subjectType: 'user',
			subjectId: reviewerId
		})
		.onConflictDoNothing();
	await formService.publishForm(form.id, guildId, reviewerId, form.data.revision);
	return { discord, attachments, delivery, applicant, userId, form };
}

async function finishAnswers(flow) {
	await formService.startSession(flow.form.id, flow.userId, [guildId]);
	await flow.delivery.tick();
	const session = await formService.findActiveSession(flow.userId);
	assert.equal(session.status, 'answer');
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	await flow.applicant.handleMessage({
		author: { id: flow.userId },
		id: flow.discord.id(),
		channel,
		content: 'I enjoy helping people.',
		attachments: new Collection(),
		reference: null
	});
	await flow.delivery.tick();
	return formService.findActiveSession(flow.userId);
}

test('first DM opens eligible forms, then submission reaches a channel-visible review and archives after a decision', async () => {
	const flow = await setupFlow();
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	await flow.applicant.handleMessage({
		author: { id: flow.userId },
		id: flow.discord.id(),
		channel,
		content: 'hello',
		attachments: new Collection()
	});
	assert.equal(await formService.findActiveSession(flow.userId), null);
	assert.match(
		JSON.stringify([
			...(channel.messages.fetch ? (await channel.messages.fetch()).values() : [])
		]),
		/Choose a form/
	);
	const confirmation = await finishAnswers(flow);
	assert.equal(confirmation.status, 'confirm');
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	await flow.delivery.tick();
	const delivered = await formService.findSubmission(submission.id);
	assert.equal(delivered.deliveryState, 'ready');
	const thread = flow.discord.channels.get(delivered.threadId);
	assert.equal(thread.type, ChannelType.PublicThread);
	assert.equal(thread.name, 'tester - Test application');
	assert.equal(thread.id, delivered.reviewMessageId);
	assert.equal(
		flow.discord.operations.filter((operation) => operation === 'create-thread').length,
		1
	);
	const card = flow.discord.reviewMessages.get(delivered.reviewMessageId);
	const cardContents = card.components[0].components;
	assert.equal(card.components[0].accent_color, 0x123456);
	assert.equal(
		cardContents.find((part) => part.type === 12).items[0].media.url.includes('banner'),
		true
	);
	assert.equal(
		cardContents.find((part) => part.type === 9).accessory.media.url.includes('avatar'),
		true
	);
	const cardText = JSON.stringify(cardContents);
	for (const detail of [
		'Server Name',
		'tester',
		'Test User',
		'<@&12345678901234111>',
		'<t:1700000000:D>',
		'<t:1600000000:D>'
	]) {
		assert.ok(cardText.includes(detail), `the card shows ${detail}`);
	}
	assert.ok(!cardText.includes(`<@&${guildId}>`), 'the everyone role is not listed');
	const visibleText = (messages) =>
		JSON.stringify(
			messages.flatMap((message) =>
				message.components.flatMap((container) =>
					(container.components ?? []).filter((part) => part.type === 10)
				)
			)
		);
	const threadMessages = [...(await thread.messages.fetch()).values()];
	assert.doesNotMatch(visibleText(threadMessages), /zf-|Applicant: /);
	assert.doesNotMatch(
		visibleText([...(await channel.messages.fetch()).values()]),
		/zf-|prompt:|Submission [0-9a-f]{8}-/
	);
	await flow.delivery.deliverReview(submission.id, 'unused-delivery');
	await database
		.update(schema.submissions)
		.set({ deliveryState: 'posting' })
		.where(eq(schema.submissions.id, submission.id));
	await flow.delivery.deliverReview(submission.id, 'unused-delivery');
	assert.equal(
		(await thread.messages.fetch()).size,
		threadMessages.length,
		'a retried delivery recognises its hidden markers'
	);
	await formService.recordDecision(
		submission.id,
		reviewerId,
		thread.id,
		'accepted',
		'Welcome aboard'
	);
	await flow.delivery.tick();
	const archived = await formService.findSubmission(submission.id);
	assert.equal(archived.status, 'accepted');
	assert.equal(archived.archived, true);
	assert.equal(thread.archived, true);
	assert.equal(thread.locked, true);
	assert.match(JSON.stringify([...(await channel.messages.fetch()).values()]), /Welcome aboard/);
	await formService.archiveForm(flow.form.id, guildId, reviewerId);
	assert.equal((await formService.findForm(flow.form.id)).archived, true);
});

test('a retried prompt recognises its hidden marker and sends no second question', async () => {
	const flow = await setupFlow();
	await formService.startSession(flow.form.id, flow.userId, [guildId]);
	await flow.delivery.tick();
	const session = await formService.findActiveSession(flow.userId);
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	const [question] = [...(await channel.messages.fetch()).values()];
	assert.doesNotMatch(JSON.stringify(question.components), /zf-prompt|prompt:/);
	assert.ok(question.components[0].id >= 1000000);
	await database
		.update(schema.sessions)
		.set({ status: 'prompt' })
		.where(eq(schema.sessions.id, session.id));
	await flow.delivery.deliverPrompt({ payload: { id: session.id, version: session.version } });
	assert.equal((await channel.messages.fetch()).size, 1);
	assert.equal((await formService.findSession(session.id)).status, 'answer');
});

test('questions show progress once, hide unusable buttons and drop numbering typed into the wording', async () => {
	const flow = await setupFlow();
	const session = await formService.startSession(flow.form.id, flow.userId, []);
	const snapshot = {
		...session.snapshot,
		questions: [
			{ ...session.snapshot.questions[0], prompt: '1. First?' },
			{ ...session.snapshot.questions[0], prompt: '2) Second?\\n-# A hint', required: false }
		]
	};
	const first = JSON.stringify(componentTree(prompt({ ...session, snapshot, position: 0 })));
	const second = JSON.stringify(componentTree(prompt({ ...session, snapshot, position: 1 })));
	assert.match(first, /### First\?/);
	assert.match(first, /Progress is saved/);
	assert.doesNotMatch(first, /"label":"Back"|"label":"Skip"/);
	assert.match(second, /### Second\?/);
	assert.doesNotMatch(second, /Progress is saved/);
	assert.match(second, /"label":"Back"/);
	assert.match(second, /"label":"Skip"/);
	assert.match(
		JSON.stringify(
			componentTree(
				prompt({
					...session,
					snapshot: {
						...snapshot,
						questions: [{ ...snapshot.questions[0], prompt: '2024 goals?' }]
					},
					position: 0
				})
			)
		),
		/### 2024 goals/
	);
});

test('a lost card response repeats its nonce instead of posting a second card', async () => {
	const flow = await setupFlow();
	const confirmation = await finishAnswers(flow);
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	flow.discord.loseNextCardResponse();
	await flow.delivery.tick();
	const retrying = await formService.findSubmission(submission.id);
	assert.equal(retrying.deliveryState, 'creating');
	assert.equal(retrying.reviewMessageId, null);
	await database
		.update(schema.jobs)
		.set({ nextAttemptAt: new Date(0) })
		.where(eq(schema.jobs.dedupe, `review:${submission.id}:0`));
	await flow.delivery.tick();
	assert.equal((await formService.findSubmission(submission.id)).deliveryState, 'ready');
	assert.equal(flow.discord.reviewMessages.size, 1);
});

test('lost thread-creation response is reconciled without creating a second thread', async () => {
	const flow = await setupFlow();
	const confirmation = await finishAnswers(flow);
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	flow.discord.loseNextCreationResponse();
	await flow.delivery.tick();
	assert.equal((await formService.findSubmission(submission.id)).deliveryState, 'creating');
	await database
		.update(schema.jobs)
		.set({ nextAttemptAt: new Date(0) })
		.where(eq(schema.jobs.dedupe, `review:${submission.id}:0`));
	await flow.delivery.tick();
	assert.equal((await formService.findSubmission(submission.id)).deliveryState, 'ready');
	assert.equal(
		flow.discord.operations.filter((operation) => operation === 'create-thread').length,
		1
	);
});

test('all question panels, long summaries and maximum-size builder panels validate as Components V2', async () => {
	const flow = await setupFlow();
	const session = await formService.startSession(flow.form.id, flow.userId, []);
	const questionTypes = [
		{ type: 'text', min: 1, max: 2000 },
		{ type: 'number', min: 0, max: 100 },
		{ type: 'choice', options: ['First', 'Second'] },
		{ type: 'attachment' }
	];
	const validatePanel = (message) => {
		assert.equal(message.flags, MessageFlags.IsComponentsV2);
		const content = message.components.map((component) => component.toJSON());
		const totalText = JSON.stringify(content).length;
		assert.ok(totalText > 0);
		let characters = 0;
		function visit(node) {
			if (Array.isArray(node)) return node.forEach(visit);
			if (!node || typeof node !== 'object') return;
			if (node.type === 10) characters += node.content.length;
			if (node.custom_id) assert.ok(node.custom_id.length <= 100);
			if (node.components) visit(node.components);
		}
		visit(content);
		assert.ok(characters <= 4000, `${characters} text characters exceeds Discord's limit`);
	};
	for (const specification of questionTypes) {
		const question = formQuestionSchema.parse({
			id: randomUUID(),
			prompt: '*'.repeat(300),
			...specification
		});
		validatePanel(
			prompt({
				...session,
				snapshot: { ...session.snapshot, name: '*'.repeat(80), questions: [question] }
			})
		);
	}
	const lengthyQuestion = formQuestionSchema.parse({
		id: randomUUID(),
		prompt: '*'.repeat(300),
		type: 'text'
	});
	const longSession = {
		...session,
		snapshot: { ...session.snapshot, name: '*'.repeat(80), questions: [lengthyQuestion] },
		answers: ['*'.repeat(2000)]
	};
	for (let page = 0; page < answerPages(longSession.answers[0]).length; page++)
		validatePanel(summary(longSession, 0, page));
	validatePanel(
		managePanel(
			{
				...flow.form,
				data: {
					...flow.form.data,
					name: '*'.repeat(80),
					description: '*'.repeat(500),
					questions: Array.from({ length: 25 }, () => lengthyQuestion)
				}
			},
			'12345678901234567890'
		)
	);
	const builder = new FormBuilder(formService, flow.delivery);
	for (const specification of questionTypes) {
		const formModal = builder.questionModal(
			flow.form.id,
			'12345678901234567890',
			99999,
			specification.type
		);
		const payload = formModal.toJSON();
		assert.ok(payload.custom_id.length <= 100);
	}
});

function incomingAttachment(flow, channel, name = 'example.txt', content = 'sample text file') {
	const attachment = {
		id: flow.discord.id(),
		url: 'https://cdn.discordapp.com/attachments/test?fresh=1',
		name,
		size: Buffer.byteLength(content)
	};
	const message = {
		id: flow.discord.id(),
		channelId: channel.id,
		channel,
		author: { id: flow.userId },
		attachments: new Collection([[attachment.id, attachment]])
	};
	channel.messages.store.set(message.id, message);
	return { message, attachment };
}

test('attachments are referenced without downloading, then buffered from the refreshed original message', async () => {
	const flow = await setupFlow();
	const session = await formService.startSession(flow.form.id, flow.userId, []);
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	const { message, attachment } = incomingAttachment(flow, channel);
	const originalFetch = global.fetch;
	let fetches = 0;
	global.fetch = async (url) => {
		assert.match(String(url), /fresh=2/);
		fetches++;
		return new Response('sample text file');
	};

	try {
		const references = await flow.attachments.capture(session.id, message);
		assert.equal(fetches, 0);
		attachment.url = 'https://cdn.discordapp.com/attachments/test?fresh=2';
		const upload = await flow.attachments.buffer(references[0]);
		assert.equal(fetches, 1);
		assert.equal(upload.attachment.toString(), 'sample text file');
		await flow.attachments.remove(references);
		await assert.rejects(flow.attachments.buffer(references[0]), /original Discord reference/);
	} finally {
		global.fetch = originalFetch;
	}
});

test('cancelled drafts delete attachment metadata during retention cleanup', async () => {
	const flow = await setupFlow();
	const session = await formService.startSession(flow.form.id, flow.userId, []);
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	const { message } = incomingAttachment(flow, channel);
	const references = await flow.attachments.capture(session.id, message);
	await formService.navigateSession(session.id, flow.userId, session.version, null, 'cancel');
	await flow.delivery.cleanup();
	assert.equal(
		(await database.select().from(schema.files).where(eq(schema.files.key, references[0].key)))
			.length,
		0
	);
});

test('submission retention removes the submission thread and answer copies while preserving policy history', async () => {
	const flow = await setupFlow();
	const confirmation = await finishAnswers(flow);
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	await flow.delivery.tick();
	const delivered = await formService.findSubmission(submission.id);
	assert.ok(flow.discord.channels.has(delivered.threadId));
	await database
		.update(schema.submissions)
		.set({ expiresAt: new Date(0) })
		.where(eq(schema.submissions.id, submission.id));
	await flow.delivery.cleanup();
	const retainedRecord = await formService.findSubmission(submission.id);
	assert.equal(retainedRecord.deliveryState, 'purged');
	assert.equal(retainedRecord.status, 'rejected');
	assert.deepEqual(retainedRecord.answers, []);
	assert.equal(flow.discord.channels.has(delivered.threadId), false);
	assert.equal(flow.discord.reviewMessages.has(delivered.reviewMessageId), false);
	assert.equal(retainedRecord.reviewMessageId, null);
	assert.deepEqual((await formService.findSession(confirmation.id)).answers, []);
	await formService.startSession(flow.form.id, flow.userId, [guildId]);
});

test('Sapphire discovers the form command, DM listener and all component handlers', async () => {
	const { SapphireClient } = require('@sapphire/framework');
	const { GatewayIntentBits, Partials, SlashCommandBuilder } = require('discord.js');
	const { resolve } = require('node:path');
	const client = new SapphireClient({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
		partials: [Partials.Channel],
		loadMessageCommandListeners: false
	});
	try {
		client.stores.registerPath(resolve('dist'));
		await Promise.all([...client.stores.values()].map((store) => store.loadAll()));
		const formCommand = client.stores.get('commands').get('form');
		assert.ok(formCommand);
		assert.equal(formCommand.location.full, resolve('dist/commands/forms/form.js'));
		assert.equal(
			client.stores.get('commands').get('ping').location.full,
			resolve('dist/commands/general/ping.js')
		);
		assert.equal(
			client.stores.get('listeners').get('messageCreate').location.full,
			resolve('dist/listeners/forms/messageCreate.js')
		);
		for (const handler of client.stores.get('interaction-handlers').values()) {
			assert.equal(
				require('node:path').dirname(handler.location.full),
				resolve('dist/interaction-handlers/forms')
			);
		}
		assert.ok(client.stores.get('listeners').has('messageCreate'));
		assert.equal(client.stores.get('interaction-handlers').size, 3);
		let commandPayload;
		formCommand.registerApplicationCommands({
			registerChatInputCommand: (configure) => {
				commandPayload = configure(new SlashCommandBuilder()).toJSON();
			}
		});
		assert.equal(commandPayload.name, 'form');
		assert.equal(commandPayload.default_member_permissions, null);
		assert.match(commandPayload.description, /Test Forms/);
		assert.deepEqual(commandPayload.options.map((option) => option.name).sort(), [
			'blacklist',
			'create',
			'list',
			'permission',
			'submissions'
		]);
		assert.ok(
			commandPayload.options
				.flatMap((subcommand) => subcommand.options ?? [])
				.every((option) => !/\bid\b/i.test(`${option.name} ${option.description}`))
		);
	} finally {
		await client.destroy();
	}
});

test('text, choice, number and attachment answers survive the complete questionnaire and review flow', async () => {
	const flow = await setupFlow();
	await formService.editFormDraft(flow.form.id, guildId, reviewerId, (configuration) => ({
		...configuration,
		questions: [
			configuration.questions[0],
			formQuestionSchema.parse({
				id: randomUUID(),
				type: 'choice',
				prompt: 'Preferred shift?',
				options: ['Morning', 'Evening']
			}),
			formQuestionSchema.parse({
				id: randomUUID(),
				type: 'number',
				prompt: 'Hours available?',
				min: 1,
				max: 40
			}),
			formQuestionSchema.parse({
				id: randomUUID(),
				type: 'attachment',
				prompt: 'Attach a reference document.'
			})
		]
	}));
	const editedForm = await formService.findForm(flow.form.id);
	await formService.publishForm(flow.form.id, guildId, reviewerId, editedForm.data.revision);
	await formService.startSession(flow.form.id, flow.userId, [guildId]);
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	const sendAnswer = async (content, attachments = new Collection()) => {
		const message = {
			author: { id: flow.userId },
			id: flow.discord.id(),
			channelId: channel.id,
			channel,
			content,
			attachments,
			reference: null
		};
		channel.messages.store.set(message.id, message);
		await flow.applicant.handleMessage(message);
	};
	await flow.delivery.tick();
	await sendAnswer('I like helping people.');
	await flow.delivery.tick();
	const choiceSession = await formService.findActiveSession(flow.userId);
	await flow.applicant.handleInteraction({
		customId: `zf:s:${choiceSession.id}:${choiceSession.version}:choice`,
		id: flow.discord.id(),
		user: { id: flow.userId },
		values: ['1'],
		inGuild: () => false,
		isStringSelectMenu: () => true,
		deferUpdate: async () => undefined,
		editReply: async () => undefined
	});
	await flow.delivery.tick();
	await sendAnswer('12');
	await flow.delivery.tick();
	const originalFetch = global.fetch;
	global.fetch = async () => new Response('My reference document');
	try {
		await sendAnswer(
			'',
			new Collection([
				[
					'file',
					{
						id: 'file',
						url: 'https://cdn.discordapp.com/attachments/reference',
						name: 'reference.txt',
						size: 21
					}
				]
			])
		);
	} finally {
		global.fetch = originalFetch;
	}
	await flow.delivery.tick();
	const confirmation = await formService.findActiveSession(flow.userId);
	assert.equal(confirmation.status, 'confirm');
	assert.deepEqual(confirmation.answers.slice(0, 3), ['I like helping people.', 'Evening', 12]);
	assert.equal(confirmation.answers[3].length, 1);
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	global.fetch = async () => new Response('My reference document');
	try {
		await flow.delivery.tick();
	} finally {
		global.fetch = originalFetch;
	}
	const reviewed = await formService.findSubmission(submission.id);
	const thread = flow.discord.channels.get(reviewed.threadId);
	const reviewMessages = [...(await thread.messages.fetch()).values()];
	assert.equal(reviewMessages.filter((message) => message.payload.files?.length).length, 1);
	await formService.recordDecision(
		submission.id,
		reviewerId,
		thread.id,
		'rejected',
		'Please apply again next round.'
	);
	await flow.delivery.tick();
	assert.equal((await formService.findSubmission(submission.id)).archived, true);
});

test('a staff reply is delivered separately from deciding the submission', async () => {
	const flow = await setupFlow();
	const confirmation = await finishAnswers(flow);
	const submission = await formService.submitSession(
		confirmation.id,
		flow.userId,
		confirmation.version,
		[guildId]
	);
	await flow.delivery.tick();
	const delivered = await formService.findSubmission(submission.id);
	await database
		.insert(schema.staffGrants)
		.values({
			guildId,
			capability: 'submissions.reply',
			subjectType: 'user',
			subjectId: reviewerId
		})
		.onConflictDoNothing();
	await formService.replyToSubmission(
		submission.id,
		{ userId: reviewerId, roleIds: [], manageServer: false, administrator: false },
		delivered.threadId,
		'Your application has reached the team.'
	);
	await flow.delivery.tick();
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	assert.match(
		JSON.stringify([...(await channel.messages.fetch()).values()]),
		/Your application has reached the team/
	);
	assert.match(
		JSON.stringify([
			...(await flow.discord.channels.get(delivered.threadId).messages.fetch()).values()
		]),
		/Your application has reached the team/
	);
	assert.equal((await formService.findSubmission(submission.id)).status, 'pending');
});

function managementEditor(flow) {
	const { StaffPermissions } = require('../dist/modules/forms/services/staff-permissions');
	const { FormBrowsing } = require('../dist/modules/forms/discord/browsing');
	const permissions = new StaffPermissions(database);
	const browsing = new FormBrowsing(formService, permissions, flow.discord.client);
	const builder = new FormBuilder(formService, flow.delivery, permissions, browsing);
	const message = { id: 'one-management-message', payload: null };
	const modals = [];
	let updates = 0;
	const interaction = (customId, kind = 'button', values = [], fields) => ({
		customId,
		guild: flow.discord.client.guilds.cache.get(guildId),
		guildId,
		user: { id: reviewerId },
		message,
		values,
		fields,
		inGuild: () => true,
		isButton: () => kind === 'button',
		isModalSubmit: () => kind === 'modal',
		isFromMessage: () => true,
		isStringSelectMenu: () => kind === 'string',
		isUserSelectMenu: () => kind === 'user',
		isRoleSelectMenu: () => kind === 'role',
		isAnySelectMenu: () => ['string', 'user', 'role'].includes(kind),
		deferUpdate: async () => {
			updates++;
		},
		editReply: async (payload) => {
			message.payload = payload;
		},
		showModal: async (modal) => {
			modals.push(modal.toJSON());
		}
	});
	return { builder, interaction, message, modals, updateCount: () => updates };
}

function componentTree(payload) {
	return payload.components.map((component) => component.toJSON());
}

function controlId(payload, label) {
	return componentTree(payload)
		.flatMap((container) => container.components)
		.filter((component) => component.type === 1)
		.flatMap((row) => row.components)
		.find((control) => control.label === label).custom_id;
}

async function openQuestion(editor, formId, questionIndex) {
	const { revision } = (await formService.findForm(formId)).data;
	await editor.builder.handleInteraction(
		editor.interaction(`zf:question:${formId}:${reviewerId}:edit:${revision}`, 'string', [
			String(questionIndex)
		])
	);
}

async function pressControl(editor, label) {
	await editor.builder.handleInteraction(
		editor.interaction(controlId(editor.message.payload, label))
	);
}

async function submitLatestModal(editor, values) {
	await editor.builder.handleInteraction(
		editor.interaction(editor.modals.at(-1).custom_id, 'modal', [], {
			getTextInputValue: (field) => values[field]
		})
	);
}

test('question editor changes one setting at a time on one management message', async () => {
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const prefix = `zf:m:${flow.form.id}:${reviewerId}`;
	await formService.editFormDraft(flow.form.id, guildId, reviewerId, (configuration) => ({
		...configuration,
		questions: [{ ...configuration.questions[0], prompt: '4. Time zone?\nCity is fine' }]
	}));
	const savedQuestion = async (index = 0) =>
		(await formService.findForm(flow.form.id)).data.questions[index];
	await editor.builder.handleInteraction(editor.interaction(`${prefix}:edit`));
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Back to form/);
	await openQuestion(editor, flow.form.id, 0);
	assert.equal(editor.modals.length, 0);
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Edit wording/);
	assert.match(
		JSON.stringify(componentTree(editor.message.payload)),
		/> 4\. Time zone\?\\n> City is fine\\n\\n\*\*Answer:\*\* 3–2000 characters/
	);

	const staleControl = controlId(editor.message.payload, 'Make optional');
	await pressControl(editor, 'Edit wording');
	const modal = editor.modals.at(-1);
	assert.equal(modal.components.length, 1);
	assert.ok(modal.components.every((component) => component.type === 18));
	assert.ok(modal.components.every((component) => component.component.type === 4));
	assert.ok(modal.components.every((component) => !('label' in component.component)));
	await submitLatestModal(editor, { prompt: 'Updated question?' });
	assert.equal((await savedQuestion()).prompt, 'Updated question?');
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Updated question/);
	await assert.rejects(
		editor.builder.handleInteraction(editor.interaction(staleControl)),
		/changed/
	);

	await pressControl(editor, 'Make optional');
	assert.equal((await savedQuestion()).required, false);
	await pressControl(editor, 'Answer limits');
	assert.equal(editor.modals.at(-1).components.length, 2);
	await submitLatestModal(editor, { minimum: '3', maximum: '500' });
	assert.equal((await savedQuestion()).max, 500);
	await pressControl(editor, 'Answer limits');
	await assert.rejects(submitLatestModal(editor, { minimum: '9', maximum: '2' }));
	assert.equal((await savedQuestion()).max, 500);

	await editor.builder.handleInteraction(editor.interaction(`${prefix}:add`));
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Back to form/);
	const { revision } = (await formService.findForm(flow.form.id)).data;
	await editor.builder.handleInteraction(
		editor.interaction(`zf:type:${flow.form.id}:${reviewerId}:${revision}`, 'string', [
			'number'
		])
	);
	assert.equal(editor.modals.at(-1).components.length, 1);
	await submitLatestModal(editor, { prompt: 'How many hours?' });
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Question 2/);
	let numberPanel = JSON.stringify(componentTree(editor.message.payload));
	assert.match(numberPanel, /A number\\n/);
	assert.doesNotMatch(numberPanel, /Whole numbers|decimals|1000000000/);
	await pressControl(editor, 'Answer limits');
	const limitsModal = editor.modals.at(-1);
	assert.ok(limitsModal.components.every(({ component }) => component.required === false));
	assert.ok(limitsModal.components.every(({ component }) => !('value' in component)));
	await submitLatestModal(editor, { minimum: '18', maximum: '' });
	assert.equal((await savedQuestion(1)).min, 18);
	assert.equal((await savedQuestion(1)).max, null);
	numberPanel = JSON.stringify(componentTree(editor.message.payload));
	assert.match(numberPanel, /A number of at least 18/);
	await pressControl(editor, 'Answer limits');
	await assert.rejects(
		submitLatestModal(editor, { minimum: 'old', maximum: '' }),
		/must be numbers/
	);

	await editor.builder.handleInteraction(editor.interaction(`${prefix}:back`));
	assert.match(JSON.stringify(componentTree(editor.message.payload)), /Add question/);
	assert.equal(editor.message.id, 'one-management-message');
});

function storeReferenceFiles(flow) {
	const channel = flow.discord.channels.get(reviewChannelId);
	const messages = new Collection();
	channel.send = async (payload) => {
		const attachments = new Collection(
			payload.files.map((file) => {
				const attachmentId = flow.discord.id();
				return [
					attachmentId,
					{
						id: attachmentId,
						name: file.name,
						size: file.attachment.length,
						contentType: file.name.endsWith('.png') ? 'image/png' : 'application/pdf',
						url: `https://cdn.discordapp.com/attachments/${attachmentId}/${file.name}`
					}
				];
			})
		);
		const message = { id: flow.discord.id(), author: { id: 'bot' }, attachments };
		messages.set(message.id, message);
		return message;
	};
	channel.messages = {
		fetch: async ({ message }) => {
			if (!messages.has(message)) {
				throw Object.assign(new Error('Unknown Message'), { code: 10008 });
			}
			return messages.get(message);
		},
		delete: async (messageId) => messages.delete(messageId)
	};
	return { channel, messages };
}

const referenceUploads = new Collection([
	[
		'1',
		{ name: 'Guide Map.png', size: 4, url: 'https://cdn.discordapp.com/attachments/1/map.png' }
	],
	['2', { name: 'rules.pdf', size: 4, url: 'https://cdn.discordapp.com/attachments/2/rules.pdf' }]
]);

function serveDiscordFiles(t, status = 200) {
	t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(4), { status }));
}

async function uploadReferenceFiles(editor, formId, control = 'Reference files') {
	await openQuestion(editor, formId, 0);
	await pressControl(editor, control);
	const modal = editor.modals.at(-1);
	assert.equal(modal.components[0].component.type, 19);
	await editor.builder.handleInteraction(
		editor.interaction(modal.custom_id, 'modal', [], {
			getUploadedFiles: () => referenceUploads
		})
	);
}

async function startAndDeliverQuestion(flow) {
	await formService.startSession(flow.form.id, flow.userId, [guildId]);
	await flow.delivery.tick();
	const channel = await (await flow.discord.client.users.fetch(flow.userId)).createDM();
	return {
		session: await formService.findActiveSession(flow.userId),
		delivered: [...(await channel.messages.fetch()).values()]
	};
}

test('reference files keep their names and reach the preview and the applicant prompt', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const prefix = `zf:m:${flow.form.id}:${reviewerId}`;
	const { messages } = storeReferenceFiles(flow);
	await uploadReferenceFiles(editor, flow.form.id);
	const saved = await formService.findForm(flow.form.id);
	assert.deepEqual(
		saved.data.questions[0].references.map(({ name, image }) => ({ name, image })),
		[
			{ name: 'Guide Map.png', image: true },
			{ name: 'rules.pdf', image: false }
		]
	);
	assert.equal(messages.size, 1);
	const storedMessageLink = `https://discord.com/channels/${guildId}/${reviewChannelId}/${saved.data.questions[0].references[0].messageId}`;
	assert.ok(
		JSON.stringify(componentTree(editor.message.payload)).includes(
			`[Guide Map.png](${storedMessageLink})`
		)
	);

	await editor.builder.handleInteraction(editor.interaction(`${prefix}:preview`));
	assert.equal(editor.message.payload.files.length, 2);
	await editor.builder.handleInteraction(editor.interaction(`${prefix}:back`));
	assert.equal(editor.message.payload.files, undefined);
	assert.deepEqual(editor.message.payload.attachments, []);

	await editor.builder.handleInteraction(editor.interaction(`${prefix}:publish`));
	const { session, delivered } = await startAndDeliverQuestion(flow);
	assert.equal(session.status, 'answer');
	assert.deepEqual(
		delivered[0].payload.files.map((file) => file.name),
		['reference-1.png', 'reference-2.pdf']
	);
	const contents = delivered[0].components[0].components;
	assert.equal(
		contents.find((component) => component.type === 12).items[0].media.url,
		'attachment://reference-1.png'
	);
	assert.equal(
		contents.find((component) => component.type === 13).file.url,
		'attachment://reference-2.pdf'
	);

	await openQuestion(editor, flow.form.id, 0);
	await pressControl(editor, 'Remove files');
	assert.deepEqual((await formService.findForm(flow.form.id)).data.questions[0].references, []);
	assert.equal(messages.size, 1);
});

test('a removed reference file blocks publishing but never strands an applicant', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const { messages } = storeReferenceFiles(flow);
	await uploadReferenceFiles(editor, flow.form.id);
	const prefix = `zf:m:${flow.form.id}:${reviewerId}`;
	await editor.builder.handleInteraction(editor.interaction(`${prefix}:publish`));
	const publishedRevision = (await formService.findForm(flow.form.id)).published.revision;
	messages.clear();

	const { session, delivered } = await startAndDeliverQuestion(flow);
	assert.equal(session.status, 'answer');
	assert.deepEqual(delivered[0].payload.files, []);
	assert.match(JSON.stringify(delivered[0].components), /no longer available/);

	await assert.rejects(
		editor.builder.handleInteraction(editor.interaction(`${prefix}:publish`)),
		/question 1 is no longer available/
	);
	assert.equal((await formService.findForm(flow.form.id)).published.revision, publishedRevision);
});

test('a temporary download failure retries the prompt instead of dropping its files', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	storeReferenceFiles(flow);
	await uploadReferenceFiles(editor, flow.form.id);
	await editor.builder.handleInteraction(
		editor.interaction(`zf:m:${flow.form.id}:${reviewerId}:publish`)
	);
	t.mock.restoreAll();
	serveDiscordFiles(t, 503);
	t.mock.method(console, 'error', () => undefined);

	const { session, delivered } = await startAndDeliverQuestion(flow);
	assert.equal(session.status, 'prompt');
	assert.equal(delivered.length, 0);
});

test('reference uploads explain missing channel permissions and invalid file limits', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const { channel, messages } = storeReferenceFiles(flow);
	const { QuestionMedia } = require('../dist/modules/forms/services/question-media');
	const media = new QuestionMedia(flow.discord.client);
	await assert.rejects(
		media.capture(guildId, reviewChannelId, [
			{
				name: 'large.png',
				size: 9 * 1024 * 1024,
				url: 'https://cdn.discordapp.com/a/large.png'
			}
		]),
		/up to 8 MiB/
	);
	channel.permissionsFor = () => ({ has: () => false });
	await assert.rejects(uploadReferenceFiles(editor, flow.form.id), /permissions/);
	assert.equal(messages.size, 0);
});

const referenceMessageId = async (formId) =>
	(await formService.findForm(formId)).data.questions[0].references[0].messageId;

const retiredRecord = async (messageId) =>
	(
		await database
			.select()
			.from(schema.retiredQuestionFiles)
			.where(eq(schema.retiredQuestionFiles.messageId, messageId))
	)[0];

test('replaced reference files are deleted only after nothing can still show them', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const publish = () =>
		editor.builder.handleInteraction(
			editor.interaction(`zf:m:${flow.form.id}:${reviewerId}:publish`)
		);
	const { messages } = storeReferenceFiles(flow);
	await uploadReferenceFiles(editor, flow.form.id);
	const replacedMessageId = await referenceMessageId(flow.form.id);
	await publish();
	const { session } = await startAndDeliverQuestion(flow);

	await uploadReferenceFiles(editor, flow.form.id, 'Replace files');
	const currentMessageId = await referenceMessageId(flow.form.id);
	await pressControl(editor, 'Make optional');
	assert.notEqual(currentMessageId, replacedMessageId);
	assert.ok(await retiredRecord(replacedMessageId));
	assert.equal(await retiredRecord(currentMessageId), undefined);
	await flow.delivery.cleanup();
	assert.ok(messages.has(replacedMessageId), 'the published form still shows the old files');

	await publish();
	await flow.delivery.cleanup();
	assert.ok(messages.has(replacedMessageId), 'the saved questionnaire still shows the old files');

	await formService.navigateSession(session.id, flow.userId, session.version, null, 'cancel');
	await flow.delivery.cleanup();
	assert.equal(messages.has(replacedMessageId), false);
	assert.ok(messages.has(currentMessageId));
	assert.equal(await retiredRecord(replacedMessageId), undefined);
});

test('removing a question retires its files and failed deletions retry', async (t) => {
	serveDiscordFiles(t);
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const { channel, messages } = storeReferenceFiles(flow);
	await uploadReferenceFiles(editor, flow.form.id);
	const messageId = await referenceMessageId(flow.form.id);
	const { revision } = (await formService.findForm(flow.form.id)).data;
	await editor.builder.handleInteraction(
		editor.interaction(
			`zf:question:${flow.form.id}:${reviewerId}:remove:${revision}`,
			'string',
			['0']
		)
	);

	const deleteMessage = channel.messages.delete;
	channel.messages.delete = async () => {
		throw Object.assign(new Error('Discord is unavailable'), { status: 500 });
	};
	t.mock.method(console, 'error', () => undefined);
	await flow.delivery.cleanup();
	assert.ok(messages.has(messageId));
	assert.ok(await retiredRecord(messageId));

	channel.messages.delete = deleteMessage;
	await flow.delivery.cleanup();
	assert.equal(messages.has(messageId), false);
	assert.equal(await retiredRecord(messageId), undefined);
});

test('a retired file that staff already deleted is forgotten', async () => {
	const flow = await setupFlow();
	const { channel } = storeReferenceFiles(flow);
	const messageId = flow.discord.id();
	await database
		.insert(schema.retiredQuestionFiles)
		.values({ messageId, channelId: reviewChannelId });
	channel.messages.delete = async () => {
		throw Object.assign(new Error('Unknown Message'), { code: 10008 });
	};
	await flow.delivery.cleanup();
	assert.equal(await retiredRecord(messageId), undefined);
});

test('native role and user pickers edit batches without losing existing access entries', async () => {
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const initialRoles = Array.from({ length: 30 }, (_, index) =>
		String(12345678901234000n + BigInt(index))
	);
	await formService.editFormDraft(flow.form.id, guildId, reviewerId, (configuration) => ({
		...configuration,
		allowRoles: initialRoles
	}));
	const form = await formService.findForm(flow.form.id);
	const accessPrefix = `zf:access:${form.id}:${reviewerId}`;
	await editor.builder.handleInteraction(editor.interaction(`${accessPrefix}:allowRoles:open`));
	let payload = componentTree(editor.message.payload);
	assert.equal(
		payload[0].components.filter(
			(component) => component.type === 1 && component.components[0].type === 6
		).length,
		2
	);
	const roleId = '12345678901234999';
	await editor.builder.handleInteraction(
		editor.interaction(`${accessPrefix}:allowRoles:add:${form.data.revision}`, 'role', [roleId])
	);
	let saved = await formService.findForm(form.id);
	assert.deepEqual(saved.data.allowRoles, [...initialRoles, roleId]);
	await assert.rejects(
		editor.builder.handleInteraction(
			editor.interaction(`${accessPrefix}:allowRoles:remove:${form.data.revision}`, 'role', [
				roleId
			])
		),
		/changed/
	);
	await editor.builder.handleInteraction(
		editor.interaction(`${accessPrefix}:allowRoles:remove:${saved.data.revision}`, 'role', [
			roleId
		])
	);
	saved = await formService.findForm(form.id);
	assert.deepEqual(saved.data.allowRoles, initialRoles);
	await editor.builder.handleInteraction(editor.interaction(`${accessPrefix}:blacklist:open`));
	payload = componentTree(editor.message.payload);
	assert.equal(
		payload[0].components.filter(
			(component) => component.type === 1 && component.components[0].type === 5
		).length,
		2
	);
	await editor.builder.handleInteraction(
		editor.interaction(`${accessPrefix}:blacklist:add:${saved.data.revision}`, 'user', [
			reviewerId
		])
	);
	const blocked = await formService.findForm(form.id);
	assert.deepEqual(blocked.data.blacklist, [reviewerId]);
	assert.deepEqual(blocked.published.blacklist, [reviewerId], 'blocks apply without publishing');
	assert.deepEqual(blocked.published.allowRoles, []);
	await assert.rejects(
		editor.builder.handleInteraction(
			editor.interaction(`${accessPrefix}:blacklist:remove:${saved.data.revision}`, 'user', [
				reviewerId
			])
		),
		/changed/
	);
	await editor.builder.handleInteraction(
		editor.interaction(`${accessPrefix}:blacklist:remove:${blocked.data.revision}`, 'user', [
			reviewerId
		])
	);
	assert.deepEqual((await formService.findForm(form.id)).published.blacklist, []);
});

test('blacklist-only staff can open Access and block users but not change other lists', async () => {
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const form = await formService.findForm(flow.form.id);
	const accessPrefix = `zf:access:${form.id}:${reviewerId}`;
	const blacklistRole = '12345678901234777';
	await database.insert(schema.staffGrants).values({
		guildId,
		capability: 'forms.blacklist',
		subjectType: 'role',
		subjectId: blacklistRole
	});
	const blacklistOnly = (interaction) => ({
		...interaction,
		guild: {
			...interaction.guild,
			members: {
				fetch: async ({ user }) => ({
					id: user,
					roles: { cache: new Collection([[blacklistRole, {}]]) },
					permissions: { has: () => false }
				})
			}
		}
	});
	await editor.builder.handleInteraction(
		blacklistOnly(editor.interaction(`zf:m:${form.id}:${reviewerId}:access`))
	);
	await editor.builder.handleInteraction(
		blacklistOnly(editor.interaction(`${accessPrefix}:blacklist:open`))
	);
	await editor.builder.handleInteraction(
		blacklistOnly(
			editor.interaction(`${accessPrefix}:blacklist:add:${form.data.revision}`, 'user', [
				reviewerId
			])
		)
	);
	const { data } = await formService.findForm(form.id);
	assert.deepEqual(data.blacklist, [reviewerId]);
	await assert.rejects(
		editor.builder.handleInteraction(
			blacklistOnly(
				editor.interaction(`${accessPrefix}:allowRoles:add:${data.revision}`, 'role', [
					blacklistRole
				])
			)
		),
		/forms\.edit/
	);
	await database
		.delete(schema.staffGrants)
		.where(eq(schema.staffGrants.subjectId, blacklistRole));
});

test('form panels replace ID commands for submissions and delivery recovery', async () => {
	const { createRuntime } = require('../dist/modules/forms/runtime');
	const { routeFormInteraction } = require('../dist/modules/forms/discord/interaction-router');
	const { SubmissionRecovery } = require('../dist/modules/forms/discord/submission-recovery');
	const { FormBrowsing } = require('../dist/modules/forms/discord/browsing');
	const { StaffPermissions } = require('../dist/modules/forms/services/staff-permissions');
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	const permissions = new StaffPermissions(database);
	const browsing = new FormBrowsing(formService, permissions, flow.discord.client);
	const runtime = createRuntime(flow.discord.client, 'postgres://unused@127.0.0.1:1/unused');
	Object.assign(runtime, {
		formService,
		permissions,
		browsing,
		delivery: flow.delivery,
		rateLimits: { enforce: async () => undefined },
		recovery: new SubmissionRecovery(formService, flow.delivery, permissions, browsing)
	});

	try {
		const panelText = () => JSON.stringify(componentTree(editor.message.payload));
		const route = (...interactionArguments) =>
			routeFormInteraction(editor.interaction(...interactionArguments));
		const confirmation = await finishAnswers(flow);
		const submission = await formService.submitSession(
			confirmation.id,
			flow.userId,
			confirmation.version,
			[guildId]
		);
		await flow.delivery.tick();
		assert.equal((await formService.findSubmission(submission.id)).deliveryState, 'ready');

		await editor.builder.handleInteraction(
			editor.interaction(`zf:m:${flow.form.id}:${reviewerId}:back`)
		);
		assert.doesNotMatch(panelText(), /Form ID/);
		await route(controlId(editor.message.payload, 'Submissions'));
		assert.match(panelText(), new RegExp(`<@${flow.userId}>`));
		await route(controlId(editor.message.payload, 'Other forms'));
		assert.match(panelText(), /Choose a form to browse/);
		await route(`zf:b:readopen:${reviewerId}`, 'string', [flow.form.id]);
		assert.match(panelText(), /Recover a failed delivery/);

		const repairId = `zf:b:repair:${flow.form.id}:${reviewerId}:0`;
		const staleThreadId = (await formService.findSubmission(submission.id)).threadId;
		await flow.discord.channels.get(staleThreadId).delete();
		assert.ok(
			flow.discord.reviewMessages.has(staleThreadId),
			'the applicant card outlives its thread'
		);
		await route(repairId, 'string', [submission.id]);
		assert.match(panelText(), /Create replacement thread/);
		await route(controlId(editor.message.payload, 'Create replacement thread'));
		assert.match(panelText(), /Delivery recovery is queued/);
		await flow.delivery.tick();
		const recovered = await formService.findSubmission(submission.id);
		assert.equal(recovered.deliveryState, 'ready');
		assert.notEqual(recovered.threadId, staleThreadId);
		assert.equal(flow.discord.reviewMessages.has(staleThreadId), false);
		assert.equal(recovered.threadId, recovered.reviewMessageId);

		await route(repairId, 'string', [submission.id]);
		assert.match(panelText(), /Delivery recovery is queued/);

		await assert.rejects(
			new SubmissionRecovery(formService, flow.delivery, permissions, browsing).handle(
				editor.interaction(repairId, 'string', [submission.id]),
				{
					...editor.interaction(repairId).guild,
					members: {
						fetch: async ({ user }) => ({
							id: user,
							roles: { cache: new Collection() },
							permissions: { has: () => false }
						})
					}
				},
				reviewerId,
				repairId.split(':')
			),
			/submissions\.repair/
		);
	} finally {
		await runtime.connection.close();
	}
});

test('staff review uses a native channel picker and saves into the same panel', async () => {
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	await editor.builder.handleInteraction(
		editor.interaction(`zf:m:${flow.form.id}:${reviewerId}:review`)
	);
	const modal = editor.modals.at(-1);
	assert.equal(modal.components[0].type, 18);
	assert.equal(modal.components[0].component.type, 8);
	assert.deepEqual(modal.components[0].component.channel_types, [ChannelType.GuildText]);
	const channelId = '12345678901234998';
	await editor.builder.handleInteraction(
		editor.interaction(modal.custom_id, 'modal', [], {
			getSelectedChannels: () => new Collection([[channelId, { id: channelId }]])
		})
	);
	assert.equal((await formService.findForm(flow.form.id)).data.reviewChannelId, channelId);
	assert.equal(editor.updateCount(), 1);
});

test('access controls reject other owners and revoked permissions before updating a panel', async () => {
	const flow = await setupFlow();
	const editor = managementEditor(flow);
	await assert.rejects(
		editor.builder.handleInteraction(
			editor.interaction(`zf:access:${flow.form.id}:someone-else:blacklist:open`)
		),
		/own panel/
	);
	const interaction = editor.interaction(
		`zf:access:${flow.form.id}:${reviewerId}:blacklist:open`
	);
	interaction.guild = {
		...interaction.guild,
		members: {
			fetch: async () => ({
				roles: { cache: new Collection() },
				permissions: { has: () => false }
			})
		}
	};
	await assert.rejects(editor.builder.handleInteraction(interaction));
	assert.equal(editor.updateCount(), 0);
});

test('panel separators stay within Discord component limits even for paragraph-heavy answers', () => {
	const { panel, buttons, button } = require('../dist/modules/forms/discord/components');
	const payload = componentTree(
		panel(Array.from({ length: 300 }, () => 'a').join('\n\n'), [
			buttons(button('test:back', 'Back'))
		])
	);
	const contents = payload[0].components;
	assert.ok(contents.some((component) => component.type === 14 && component.divider));
	assert.ok(contents.length < 40);
	assert.equal(
		contents
			.filter((component) => component.type === 10)
			.map((component) => component.content)
			.join('\n\n'),
		Array.from({ length: 300 }, () => 'a').join('\n\n')
	);
});
