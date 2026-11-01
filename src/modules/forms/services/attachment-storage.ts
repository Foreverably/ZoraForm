import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { Attachment } from 'discord.js';
import { eq } from 'drizzle-orm';
import { files } from '../../../database/schema';
import type { Database } from '../../../database/database';
import { FormError } from '../domain/rules';
import type { StoredAttachment } from '../domain/types';

export class AttachmentStorage {
	public readonly directory: string;

	public constructor(
		private readonly database: Database,
		directory: string
	) {
		this.directory = resolve(directory);
	}

	public path(key: string) {
		if (!/^[a-f0-9-]{36}$/.test(key)) {
			throw new FormError('Invalid attachment key.');
		}
		return join(this.directory, key);
	}

	public async ingest(sessionId: string, attachments: Attachment[]): Promise<StoredAttachment[]> {
		if (
			!attachments.length ||
			attachments.length > 3 ||
			attachments.some((attachment) => attachment.size > 8 * 1024 * 1024) ||
			attachments.reduce((sum, attachment) => sum + attachment.size, 0) > 20 * 1024 * 1024
		) {
			throw new FormError('Attach 1–3 files, up to 8 MiB each and 20 MiB total.');
		}
		await mkdir(this.directory, {
			recursive: true,
			mode: 0o700
		});
		const stored: StoredAttachment[] = [];
		try {
			for (const attachment of attachments) {
				const url = new URL(attachment.url);
				if (
					url.protocol !== 'https:' ||
					!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
				) {
					throw new FormError('Unsupported attachment source.');
				}
				const response = await fetch(url, {
					signal: AbortSignal.timeout(30000),
					redirect: 'error'
				});
				if (!response.ok || !response.body) {
					throw new FormError('Could not download the file. Please retry.');
				}
				const chunks: Uint8Array[] = [];
				let size = 0;
				for await (const chunk of response.body) {
					size += chunk.length;
					if (size > 8 * 1024 * 1024) {
						throw new FormError('File exceeds 8 MiB.');
					}
					chunks.push(chunk);
				}
				const bytes = Buffer.concat(chunks);
				let extension = '';
				if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
					extension = 'png';
				} else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
					extension = 'jpg';
				} else if (bytes.subarray(0, 5).toString() === '%PDF-') {
					extension = 'pdf';
				} else if (attachment.name.toLowerCase().endsWith('.txt') && !bytes.includes(0)) {
					try {
						new TextDecoder('utf-8', { fatal: true }).decode(bytes);
						extension = 'txt';
					} catch {
						throw new FormError('Text files must use UTF-8.');
					}
				}
				if (!extension) {
					throw new FormError('Only PNG, JPEG, PDF and UTF-8 text files are supported.');
				}
				const key = randomUUID();
				const asset = {
					key,
					name: `attachment-${stored.length + 1}.${extension}`,
					size
				};
				await writeFile(this.path(key), bytes, {
					mode: 0o600,
					flag: 'wx'
				});
				try {
					await this.database.insert(files).values({
						...asset,
						sessionId: sessionId
					});
				} catch (error) {
					await unlink(this.path(key));
					throw error;
				}
				stored.push(asset);
			}
			return stored;
		} catch (error) {
			await this.remove(stored);
			throw error;
		}
	}

	public async remove(assets: StoredAttachment[]) {
		for (const asset of assets) {
			await unlink(this.path(asset.key)).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			});
			await this.database.delete(files).where(eq(files.key, asset.key));
		}
	}
}
