import { getBotName } from '../../../lib/environment';
import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	ButtonStyle,
	ComponentType,
	type APIContainerComponent,
	type Client,
	type Message,
	type ButtonInteraction,
	type StringSelectMenuInteraction
} from 'discord.js';
import { FormService } from '../services/form-service';
import { AttachmentTransfer } from '../services/attachment-transfer';
import { FormError, SubmissionLimitError, outdatedControl } from '../domain/rules';
import type { QuestionnaireSession } from '../domain/types';
import { panel, buttons, button, questionHeading, safe, summary } from './components';

const maximumListedLimits = 10;

export class ApplicantFlow {
	public constructor(
		private readonly client: Client,
		private readonly formService: FormService,
		private readonly attachments: AttachmentTransfer
	) {}

	public async memberRoles(guildId: string, userId: string) {
		const guild = this.client.guilds.cache.get(guildId);

		if (!guild) {
			return null;
		}

		try {
			const member = await guild.members.fetch({ user: userId, force: true });
			return [...member.roles.cache.keys()];
		} catch (error) {
			if (typeof error === 'object' && error && 'code' in error && error.code === 10007) {
				return null;
			}

			throw new FormError(
				'Your server membership could not be checked just now. Your progress is safe, so please try again.'
			);
		}
	}

	public async directory(userId: string, requestedPage = 0) {
		const availableForms = [];
		const limitedForms: string[] = [];
		const guildRoles = new Map<string, Awaited<ReturnType<ApplicantFlow['memberRoles']>>>();

		for (const form of await this.formService.listForms()) {
			if (!form.published) {
				continue;
			}

			if (!guildRoles.has(form.guildId)) {
				guildRoles.set(form.guildId, await this.memberRoles(form.guildId, userId));
			}

			try {
				await this.formService.assertEligibility(
					form,
					userId,
					guildRoles.get(form.guildId) ?? null
				);
				availableForms.push(form);
			} catch (error) {
				if (error instanceof SubmissionLimitError) {
					const guildName =
						this.client.guilds.cache.get(form.guildId)?.name ?? 'Community';
					limitedForms.push(
						`**${safe(form.published!.name)}** · ${safe(guildName)}\n-# ${error.message}`
					);
				} else if (!(error instanceof FormError)) {
					throw error;
				}
			}
		}

		const pageCount = Math.max(1, Math.ceil(availableForms.length / 25));
		const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
		const pageForms = availableForms.slice(page * 25, page * 25 + 25);
		const controls = [];

		if (pageForms.length) {
			controls.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId('zf:directory:select')
						.setPlaceholder('Choose a form')
						.addOptions(
							pageForms.map((form) => ({
								label: form.published!.name,
								description: (
									this.client.guilds.cache.get(form.guildId)?.name ?? 'Community'
								).slice(0, 100),
								value: form.id
							}))
						)
				)
			);
		}

		if (pageCount > 1) {
			controls.push(
				buttons(
					button(`zf:directory:page:${page - 1}`, 'Previous').setDisabled(page === 0),
					button(`zf:directory:page:${page + 1}`, 'Next').setDisabled(
						page === pageCount - 1
					)
				)
			);
		}

		controls.push(
			buttons(
				button(`zf:directory:page:${page}`, 'Refresh'),
				button('zf:directory:status', 'My submissions')
			)
		);

		const hiddenLimits = limitedForms.length - maximumListedLimits;
		const limits = limitedForms.length
			? `\n\n### Not available right now\n${limitedForms.slice(0, maximumListedLimits).join('\n')}${hiddenLimits > 0 ? `\n-# And ${hiddenLimits} more.` : ''}`
			: '';

		return panel(
			`## ${safe(getBotName())}\n${pageForms.length ? 'Choose a form to begin. Each answer is saved automatically.' : 'There are no forms available to you right now. Try Refresh later.'}${limits}${pageCount > 1 ? `\n\n-# Page ${page + 1} of ${pageCount}` : ''}`,
			controls
		);
	}

	private resumePanel(session: QuestionnaireSession) {
		const prefix = `zf:s:${session.id}:${session.version}`;

		return panel(
			`## ${safe(session.snapshot.name)}\nYour saved questionnaire is ${session.status === 'paused' ? 'paused' : 'in progress'}. Resume to see the current question, or cancel to choose a different form.`,
			[
				buttons(
					button(`${prefix}:resume`, 'Resume', ButtonStyle.Primary),
					button(`${prefix}:cancel`, 'Cancel', ButtonStyle.Danger)
				)
			]
		);
	}

	public async handleMessage(message: Message) {
		if (!message.channel.isSendable()) {
			return;
		}

		const session = await this.formService.findActiveSession(message.author.id);

		if (!session) {
			await message.channel.send(await this.directory(message.author.id));
			return;
		}

		if (session.status !== 'answer') {
			await message.channel.send(this.resumePanel(session));
			return;
		}

		const question = session.snapshot.questions[session.position];

		if (!question) {
			throw new FormError('Press Resume on your saved form to continue.');
		}

		if (question.type === 'choice') {
			throw new FormError('Pick your answer from the menu on the latest question.');
		}

		const memberRoleIds = await this.memberRoles(session.guildId, message.author.id);
		const currentForm = await this.formService.findForm(session.formId);
		await this.formService.assertEligibility(currentForm, message.author.id, memberRoleIds);

		if (question.type !== 'attachment' && message.attachments.size) {
			throw new FormError('This question needs a written answer, not a file.');
		}

		const attachments =
			question.type === 'attachment'
				? await this.attachments.capture(session.id, message)
				: [];

		try {
			const answerSaved = await this.formService.saveAnswer(
				session.id,
				message.author.id,
				session.version,
				memberRoleIds,
				message.id,
				message.content,
				attachments,
				message.reference?.messageId ?? undefined
			);

			if (answerSaved) {
				void this.removeAnsweredControls(message, session.promptId);
			} else {
				await this.attachments.remove(attachments);
			}
		} catch (error) {
			await this.attachments.remove(attachments);
			throw error;
		}
	}

	// Buttons under an answered question only lead to an out-of-date notice. This is cosmetic, so
	// it runs on the side and must never hold up the next question.
	private async removeAnsweredControls(message: Message, promptId: string | null) {
		if (!promptId) {
			return;
		}

		try {
			const question = await message.channel.messages.fetch(promptId);
			const containers = JSON.parse(
				JSON.stringify(question.components)
			) as APIContainerComponent[];

			await question.edit({
				components: containers.map((container) => ({
					...container,
					components: container.components.filter(
						(part) =>
							part.type !== ComponentType.ActionRow &&
							part.type !== ComponentType.Separator
					)
				}))
			});
		} catch {
			// The question stays as it is, and its old buttons explain that they are out of date.
		}
	}

	// The next question arrives as its own message, so the old controls can simply go.
	private async clearControlMessage(
		interaction: ButtonInteraction | StringSelectMenuInteraction
	) {
		await interaction.deleteReply().catch(() => undefined);
	}

	public async handleInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
		if (interaction.inGuild()) {
			throw new FormError(`Use the questionnaire controls in your DMs with ${getBotName()}.`);
		}

		const segments = interaction.customId.split(':');
		await interaction.deferUpdate();

		if (segments[1] === 'directory') {
			if (segments[2] === 'select' && interaction.isStringSelectMenu()) {
				const formId = interaction.values[0];

				if (!formId) {
					throw new FormError(outdatedControl);
				}

				const form = await this.formService.findForm(formId);
				await this.formService.startSession(
					formId,
					interaction.user.id,
					await this.memberRoles(form.guildId, interaction.user.id)
				);
				await this.clearControlMessage(interaction);
				return;
			}

			await interaction.editReply(
				await this.directory(interaction.user.id, Number(segments[3] ?? 0))
			);
			return;
		}

		const sessionId = segments[2]!;
		const version = Number(segments[3]);
		const action = segments[4];
		const session = await this.formService.findSession(sessionId);

		if (session.userId !== interaction.user.id || session.version !== version) {
			throw new FormError(
				'These buttons are out of date. Use the latest question, or send the bot a message to carry on.'
			);
		}

		if (action === 'cancel') {
			await interaction.editReply(
				panel('Cancel this questionnaire? Your progress will be discarded.', [
					buttons(
						button(
							`zf:s:${session.id}:${version}:cancel-confirm`,
							'Yes, cancel',
							ButtonStyle.Danger
						),
						button(`zf:s:${session.id}:${version}:resume`, 'Keep answering')
					)
				])
			);
			return;
		}

		const roles =
			action === 'cancel-confirm'
				? null
				: await this.memberRoles(session.guildId, interaction.user.id);

		if (action === 'summary') {
			if (session.status !== 'confirm') {
				throw new FormError('Finish your answers before reviewing them.');
			}
			await this.formService.assertEligibility(
				await this.formService.findForm(session.formId),
				interaction.user.id,
				roles
			);
			await interaction.editReply(
				summary(session, Number(segments[5] ?? 0), Number(segments[6] ?? 0))
			);
			return;
		}

		if (action === 'submit') {
			for (const answer of session.answers) {
				if (Array.isArray(answer)) {
					for (const attachment of answer) {
						await this.attachments.assertAvailable(attachment);
					}
				}
			}

			const submission = await this.formService.submitSession(
				session.id,
				interaction.user.id,
				version,
				roles
			);
			await interaction.editReply(
				panel(
					`✅ **${safe(session.snapshot.name)}** submitted. Staff will review it, and you will get a DM with their decision.
-# Submission ID: \`${submission.id}\``
				)
			);
			return;
		}

		if (action === 'choice' && interaction.isStringSelectMenu()) {
			const question = session.snapshot.questions[session.position];
			const choiceIndex = Number(interaction.values[0]);

			if (
				question?.type !== 'choice' ||
				!Number.isInteger(choiceIndex) ||
				!question.options[choiceIndex]
			) {
				throw new FormError('Choose one of the listed answers.');
			}

			await this.formService.saveAnswer(
				session.id,
				interaction.user.id,
				version,
				roles,
				interaction.id,
				question.options[choiceIndex]!
			);
			await interaction.editReply(
				panel(
					`-# **${safe(session.snapshot.name)}** · Question ${session.position + 1} of ${session.snapshot.questions.length}
${questionHeading(question.prompt)}
✅ ${safe(question.options[choiceIndex]!)}`
				)
			);
			return;
		}

		if (action === 'edit') {
			await this.formService.editAnswerPosition(
				session.id,
				interaction.user.id,
				version,
				roles,
				Number(segments[5])
			);
			await this.clearControlMessage(interaction);
			return;
		}

		const navigation = action === 'cancel-confirm' ? 'cancel' : action;

		if (
			navigation !== 'resume' &&
			navigation !== 'back' &&
			navigation !== 'skip' &&
			navigation !== 'pause' &&
			navigation !== 'cancel'
		) {
			throw new FormError(outdatedControl);
		}

		await this.formService.navigateSession(
			session.id,
			interaction.user.id,
			version,
			roles,
			navigation
		);
		if (navigation === 'cancel') {
			await interaction.editReply(await this.directory(interaction.user.id));
		} else if (navigation === 'pause') {
			await interaction.editReply(
				panel('⏸️ Paused. Send the bot a message when you are ready to carry on.')
			);
		} else {
			await this.clearControlMessage(interaction);
		}
	}
}
