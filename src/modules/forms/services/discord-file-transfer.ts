import { FormError } from '../domain/rules';

export const maximumFileBytes = 8 * 1024 * 1024;
export const maximumQuestionFileBytes = 20 * 1024 * 1024;

export async function downloadDiscordFile(urlValue: string, expectedSize: number) {
	const url = new URL(urlValue);

	if (
		url.protocol !== 'https:' ||
		!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
	) {
		throw new FormError('That file is not hosted on Discord, so it cannot be used.');
	}

	if (expectedSize <= 0 || expectedSize > maximumFileBytes) {
		throw new FormError('Files can be up to 8 MiB each and cannot be empty.');
	}

	const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });

	if (!response.ok || !response.body) {
		throw new FormError('That file could not be copied just now. Please try again.');
	}

	const chunks: Uint8Array[] = [];
	let size = 0;

	for await (const chunk of response.body) {
		size += chunk.length;

		if (size > maximumFileBytes || size > expectedSize) {
			throw new FormError('That file is larger than expected or over the 8 MiB limit.');
		}

		chunks.push(chunk);
	}

	if (size !== expectedSize) {
		throw new FormError('That file changed. Please upload it again.');
	}

	return Buffer.concat(chunks);
}
