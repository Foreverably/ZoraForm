import '@sapphire/plugin-logger/register';
import { initializeEnvironment } from './lib/environment';

import { LogLevel, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import { createRuntime } from './modules/forms/runtime';

initializeEnvironment();

const client = new SapphireClient({
	logger: { level: LogLevel.Info },
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
	partials: [Partials.Channel],
	loadMessageCommandListeners: false,
	allowedMentions: { parse: [], repliedUser: false }
});

let runtime: ReturnType<typeof createRuntime> | undefined;
let shuttingDown = false;

async function shutdown() {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	await runtime?.delivery.stop();
	await client.destroy();
	await runtime?.connection.close();
}

async function main() {
	const token = process.env.DISCORD_TOKEN?.trim();
	const databaseUrl = process.env.DATABASE_URL?.trim();

	if (!token || !databaseUrl) {
		client.logger.error(
			'Set DISCORD_TOKEN and DATABASE_URL in the root .env file before starting ZoraForms.'
		);
		process.exitCode = 1;
		return;
	}

	try {
		runtime = createRuntime(client, databaseUrl);
		await runtime.connection.applyMigrations();
		await client.login(token);
	} catch {
		client.logger.error(
			'Startup failed. Check the database connection, migrations, and Discord token.'
		);
		await shutdown();
		process.exitCode = 1;
	}
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		void shutdown().catch(() => {
			process.exitCode = 1;
		});
	});
}

void main();
