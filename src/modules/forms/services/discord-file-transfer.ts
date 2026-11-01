import { FormError } from '../domain/rules';

export const maximumFileBytes = 8 * 1024 * 1024;
export const maximumQuestionFileBytes = 20 * 1024 * 1024;

export async function downloadDiscordFile(urlValue: string, expectedSize: number) {
	const url = new URL(urlValue);

	if (
		url.protocol !== 'https:' ||
		!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
	) {
		throw new FormError('Unsupported attachment source.');
	}

	if (expectedSize <= 0 || expectedSize > maximumFileBytes) {
		throw new FormError('Files must be between 1 byte and 8 MiB.');
	}

	const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });

	if (!response.ok || !response.body) {
		throw new FormError('The attachment could not be transferred. Please retry.');
	}

	const chunks: Uint8Array[] = [];
	let size = 0;

	for await (const chunk of response.body) {
		size += chunk.length;

		if (size > maximumFileBytes || size > expectedSize) {
			throw new FormError('The attachment exceeds its expected size or the 8 MiB limit.');
		}

		chunks.push(chunk);
	}

	if (size !== expectedSize) {
		throw new FormError('The attachment changed. Please upload it again.');
	}

	return Buffer.concat(chunks);
}
