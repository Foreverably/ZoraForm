import { downloadDiscordFile } from './discord-file-transfer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Client, Message } from 'discord.js';
import { eq } from 'drizzle-orm';
import { files } from '../../../database/schema';
import type { Database } from '../../../database/database';
import { FormError } from '../domain/rules';
import type { AttachmentReference } from '../domain/types';

export class AttachmentTransfer {
	public constructor(
		private readonly database: Database,
		private readonly client: Client
	) {}

	public async capture(sessionId: string, message: Message): Promise<AttachmentReference[]> {
		const attachments = [...message.attachments.values()];

		if (
			!attachments.length ||
			attachments.length > 3 ||
			attachments.some((attachment) => attachment.size > 8 * 1024 * 1024) ||
			attachments.reduce((sum, attachment) => sum + attachment.size, 0) > 20 * 1024 * 1024
		) {
			throw new FormError('Attach 1–3 files, up to 8 MiB each and 20 MiB total.');
		}

		return this.database.transaction(async (database) => {
			const captured: AttachmentReference[] = [];

			for (const [index, attachment] of attachments.entries()) {
				const originalExtension = extname(attachment.name)
					.replace(/[^.a-zA-Z0-9]/g, '')
					.slice(0, 12);
				const reference = {
					key: randomUUID(),
					name: `attachment-${index + 1}${originalExtension}`,
					size: attachment.size
				};

				await database.insert(files).values({
					...reference,
					sessionId,
					sourceChannelId: message.channelId,
					sourceMessageId: message.id,
					sourceAttachmentId: attachment.id
				});

				captured.push(reference);
			}

			return captured;
		});
	}

	private async originalAttachment(reference: AttachmentReference) {
		const [source] = await this.database
			.select()
			.from(files)
			.where(eq(files.key, reference.key));

		if (!source?.sourceChannelId || !source.sourceMessageId || !source.sourceAttachmentId) {
			throw new FormError(
				'This upload has no original Discord reference. The applicant must attach it again.'
			);
		}

		const channel = await this.client.channels.fetch(source.sourceChannelId);

		if (!channel?.isDMBased() || !('messages' in channel)) {
			throw new FormError('The original attachment message is unavailable.');
		}

		const message = await channel.messages
			.fetch({
				message: source.sourceMessageId,
				force: true
			})
			.catch((error) => {
				if (error?.code === 10008 || error?.code === 10003) {
					throw new FormError(
						'The original DM upload was removed. Edit that attachment answer and send it again.'
					);
				}

				throw error;
			});
		const attachment = message.attachments.get(source.sourceAttachmentId);

		if (!attachment || attachment.size > 8 * 1024 * 1024) {
			throw new FormError(
				'The original attachment was removed or is too large. Ask the applicant to attach it again.'
			);
		}

		if (attachment.size !== source.size) {
			throw new FormError(
				'The original attachment changed. Edit that attachment answer and send it again.'
			);
		}

		return { attachment, expectedSize: source.size };
	}

	public async assertAvailable(reference: AttachmentReference) {
		await this.originalAttachment(reference);
	}

	public async buffer(reference: AttachmentReference) {
		const { attachment, expectedSize } = await this.originalAttachment(reference);

		return {
			attachment: await downloadDiscordFile(attachment.url, expectedSize),
			name: reference.name
		};
	}

	public async remove(references: AttachmentReference[]) {
		for (const reference of references) {
			await this.database.delete(files).where(eq(files.key, reference.key));
		}
	}
}
