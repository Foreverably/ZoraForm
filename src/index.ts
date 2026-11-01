import './lib/setup';

import { LogLevel, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';

const client = new SapphireClient({
	logger: { level: LogLevel.Info },
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
	partials: [Partials.Channel],
	loadMessageCommandListeners: false,
	allowedMentions: { parse: [], repliedUser: false }
});

async function main() {
	const token = process.env.DISCORD_TOKEN?.trim();
	if (!token) {
		client.logger.error('Set DISCORD_TOKEN in the root .env file before starting ZoraForms.');
		process.exitCode = 1;
		return;
	}

	try {
		await client.login(token);
	} catch (error) {
		client.logger.fatal(error);
		await client.destroy();
		process.exitCode = 1;
	}
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		void client.destroy();
	});
}

void main();
