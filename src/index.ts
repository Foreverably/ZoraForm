import '@sapphire/plugin-logger/register';
import { initializeEnvironment, getBotName } from './lib/environment';

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

function findPostgresError(error: unknown): Record<string, unknown> | undefined {
	const visited = new Set<unknown>();
	const pending = [error];

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== 'object' || visited.has(current)) {
			continue;
		}

		visited.add(current);
		const record = current as Record<string, unknown>;
		if ('code' in record && typeof record.code === 'string') {
			return record;
		}

		if ('cause' in record) {
			pending.push(record.cause);
		}
	}

	return undefined;
}

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

	if (!token || !databaseUrl || !process.env.BotName?.trim()) {
		client.logger.error(
			'Set BotName, DISCORD_TOKEN and DATABASE_URL in the root .env file before starting the bot.'
		);
		process.exitCode = 1;
		return;
	}

	try {
		getBotName();
		runtime = createRuntime(client, databaseUrl);
		client.logger.info('Applying database migrations...');
		await runtime.connection.applyMigrations();
		client.logger.info('Database migrations applied.');
		await client.login(token);
		client.logger.info('Discord login succeeded.');
	} catch (error) {
		const message =
			error instanceof Error
				? error.message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://[redacted]@')
				: String(error);
		const postgresError = findPostgresError(error);
		const postgresCode =
			postgresError && typeof postgresError === 'object' && 'code' in postgresError
				? postgresError.code
				: undefined;
		const postgresDetail =
			postgresError && typeof postgresError === 'object' && 'detail' in postgresError
				? postgresError.detail
				: undefined;
		const detail =
			postgresCode === '42501'
				? ' Database privileges are insufficient; grant CREATE on the database and ownership/usage of its public schema.'
				: '';
		client.logger.error(`Startup failed: ${message}`);
		if (postgresCode) {
			client.logger.error(`PostgreSQL code: ${postgresCode}`);
		}
		if (typeof postgresDetail === 'string' && postgresDetail.trim()) {
			client.logger.error(`PostgreSQL detail: ${postgresDetail}`);
		}
		if (detail) {
			client.logger.error(detail.trim());
		}
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
