import { extname } from 'node:path';
import {
	ChannelType,
	FileBuilder,
	MediaGalleryBuilder,
	MediaGalleryItemBuilder,
	PermissionFlagsBits,
	TextDisplayBuilder,
	type Attachment,
	type Client,
	type ContainerBuilder,
	type Message
} from 'discord.js';
import type { FormQuestion, QuestionReference } from '../domain/types';
import { FormError } from '../domain/rules';
import { questionReferenceSchema } from '../domain/schemas';
import {
	downloadDiscordFile,
	maximumFileBytes,
	maximumQuestionFileBytes
} from './discord-file-transfer';

// Unknown Channel, Unknown Message and Missing Access do not resolve by retrying.
const permanentlyUnavailableCodes = new Set([10003, 10008, 50001]);

type SourceMessages = Map<string, Message | null>;

export class QuestionMedia {
	public constructor(private readonly client: Client) {}

	public async capture(
		guildId: string,
		channelId: string,
		uploads: readonly Attachment[]
	): Promise<QuestionReference[]> {
		if (
			!uploads.length ||
			uploads.length > 3 ||
			uploads.some((upload) => upload.size <= 0 || upload.size > maximumFileBytes) ||
			uploads.reduce((total, upload) => total + upload.size, 0) > maximumQuestionFileBytes
		) {
			throw new FormError('Upload 1–3 reference files, up to 8 MiB each and 20 MiB total.');
		}

		const channel = await this.client.channels.fetch(channelId);

		if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) {
			throw new FormError('Choose a valid review channel before uploading question files.');
		}

		const botMember = await channel.guild.members.fetchMe();
		const requiredPermissions = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.AttachFiles,
			PermissionFlagsBits.ReadMessageHistory
		];

		if (!channel.permissionsFor(botMember)?.has(requiredPermissions)) {
			throw new FormError(
				'The bot needs view, send, attachment and history permissions in the review channel to keep reference files there.'
			);
		}

		const files = [];
		const originalNames = new Map<string, string>();

		for (const [index, upload] of uploads.entries()) {
			const name = this.filename(index, upload.name);
			originalNames.set(name, upload.name);
			files.push({
				attachment: await downloadDiscordFile(upload.url, upload.size),
				name
			});
		}

		const message = await channel.send({
			content:
				'Question reference files — keep this message while forms or saved questionnaires use these files.',
			files,
			allowedMentions: { parse: [] }
		});

		return [...message.attachments.values()].map((attachment) =>
			questionReferenceSchema.parse({
				channelId,
				messageId: message.id,
				attachmentId: attachment.id,
				name: (originalNames.get(attachment.name) ?? attachment.name).slice(0, 100),
				size: attachment.size,
				image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
					attachment.contentType ?? ''
				)
			})
		);
	}

	public async discard(references: QuestionReference[]) {
		const source = references[0];

		if (!source) {
			return;
		}

		const channel = await this.client.channels.fetch(source.channelId);

		if (channel && 'messages' in channel) {
			await channel.messages.delete(source.messageId);
		}
	}

	public async assertAvailable(questions: readonly FormQuestion[]) {
		const sourceMessages: SourceMessages = new Map();

		for (const [questionIndex, question] of questions.entries()) {
			for (const reference of question.references ?? []) {
				if (!(await this.findAttachment(reference, sourceMessages))) {
					throw new FormError(
						`A reference file on question ${questionIndex + 1} is no longer available. Upload it again in the question editor.`
					);
				}
			}
		}
	}

	// Saved questionnaires are pinned to their snapshot, so a removed file can never be
	// replaced for them. The question is still shown, with a notice, rather than blocked.
	public async decorate<MessagePayload extends { components: ContainerBuilder[] }>(
		payload: MessagePayload,
		question: FormQuestion | undefined
	) {
		const files = [];
		const images = new MediaGalleryBuilder();
		const documents: FileBuilder[] = [];
		const sourceMessages: SourceMessages = new Map();
		let unavailableFiles = 0;

		for (const [index, reference] of (question?.references ?? []).entries()) {
			const attachment = await this.findAttachment(reference, sourceMessages);

			if (!attachment) {
				unavailableFiles++;
				continue;
			}

			const name = this.filename(index, reference.name);
			files.push({
				attachment: await downloadDiscordFile(attachment.url, reference.size),
				name
			});

			if (reference.image) {
				images.addItems(
					new MediaGalleryItemBuilder()
						.setURL(`attachment://${name}`)
						.setDescription(`Question reference ${index + 1}`)
				);
			} else {
				documents.push(new FileBuilder().setURL(`attachment://${name}`));
			}
		}

		payload.components[0]!.spliceComponents(
			1,
			0,
			...(images.items.length ? [images] : []),
			...documents,
			...(unavailableFiles
				? [
						new TextDisplayBuilder().setContent(
							`-# ${unavailableFiles === 1 ? 'A reference file for this question is' : 'Some reference files for this question are'} no longer available.`
						)
					]
				: [])
		);

		return { ...payload, files, attachments: [] };
	}

	private filename(index: number, name: string) {
		return `reference-${index + 1}${extname(name)
			.replace(/[^.a-zA-Z0-9]/g, '')
			.slice(0, 12)}`;
	}

	private async findAttachment(reference: QuestionReference, sourceMessages: SourceMessages) {
		const sourceKey = `${reference.channelId}:${reference.messageId}`;

		if (!sourceMessages.has(sourceKey)) {
			sourceMessages.set(sourceKey, await this.sourceMessage(reference));
		}

		const attachment = sourceMessages.get(sourceKey)?.attachments.get(reference.attachmentId);

		return attachment?.size === reference.size ? attachment : null;
	}

	private async sourceMessage(reference: QuestionReference) {
		try {
			const channel = await this.client.channels.fetch(reference.channelId);

			if (!channel || !('messages' in channel)) {
				return null;
			}

			const message = await channel.messages.fetch({
				message: reference.messageId,
				force: true
			});

			return message.author.id === this.client.user?.id ? message : null;
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				permanentlyUnavailableCodes.has(error.code as number)
			) {
				return null;
			}

			throw error;
		}
	}
}
