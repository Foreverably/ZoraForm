import {
	ActionRowBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	MessageFlags,
	type ButtonInteraction,
	type StringSelectMenuInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import { formsRuntime, explainFormError } from './runtime';
import { FormError } from './model';

type FormInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export async function routeFormInteraction(interaction: FormInteraction) {
	try {
		const runtime = formsRuntime();
		const route = interaction.customId.split(':')[1];

		if (route === 'r') {
			const [, , submissionId, decision] = interaction.customId.split(':');
			const submission = await runtime.engine.findSubmission(submissionId!);
			const form = await runtime.engine.findForm(submission.formId);

			if (
				!interaction.channelId ||
				interaction.guildId !== submission.guildId ||
				interaction.channelId !== submission.threadId ||
				!form.data.reviewerIds.includes(interaction.user.id)
			) {
				throw new FormError('You cannot review this submission from here.');
			}

			if (decision !== 'accepted' && decision !== 'rejected') {
				throw new FormError('Unknown review decision.');
			}

			if (interaction.isButton()) {
				if (submission.status !== 'pending') {
					throw new FormError(`This submission is already ${submission.status}.`);
				}
				await interaction.showModal(
					new ModalBuilder()
						.setCustomId(interaction.customId)
						.setTitle(
							decision === 'accepted' ? 'Accept submission' : 'Reject submission'
						)
						.addComponents(
							new ActionRowBuilder<TextInputBuilder>().addComponents(
								new TextInputBuilder()
									.setCustomId('reason')
									.setLabel('Reason sent to the applicant')
									.setStyle(TextInputStyle.Paragraph)
									.setMaxLength(1000)
									.setRequired(true)
							)
						)
				);
				return;
			}

			if (!interaction.isModalSubmit()) {
				throw new FormError('Use the review buttons.');
			}

			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await runtime.engine.recordDecision(
				submission.id,
				interaction.user.id,
				interaction.channelId,
				decision,
				interaction.fields.getTextInputValue('reason')
			);
			await interaction.editReply(
				'Decision saved. The applicant notification and thread archival are queued.'
			);
			return;
		}

		if (route === 's' || route === 'directory') {
			if (interaction.isModalSubmit()) {
				throw new FormError('Use the questionnaire controls.');
			}
			await runtime.applicants.handleInteraction(interaction);
			return;
		}

		await runtime.builder.handleInteraction(interaction);
	} catch (error) {
		const content = explainFormError(error);

		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ content });
		} else {
			await interaction.reply({
				content,
				...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {})
			});
		}
	}
}
