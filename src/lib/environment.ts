import { setup } from '@skyra/env-utilities';
import { join } from 'node:path';

export const rootDir = join(__dirname, '..', '..');

export function initializeEnvironment() {
	process.env.NODE_ENV ??= 'development';

	setup({ path: join(rootDir, '.env') });
}

export function getBotName() {
	const botName = process.env.BotName?.trim();

	if (!botName || botName.length > 50 || /[\r\n]/.test(botName)) {
		throw new Error('Set BotName in .env to a single-line name containing 1–50 characters.');
	}

	return botName;
}
