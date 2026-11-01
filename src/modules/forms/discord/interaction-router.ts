import {
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	MessageFlags,
	type ButtonInteraction,
	type AnySelectMenuInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import { formsRuntime } from '../runtime';
import { errorPanel, managePanel, buttons, button } from './components';
import { FormError, outdatedControl } from '../domain/rules';

type FormInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

async function browse(interaction: ButtonInteraction | AnySelectMenuInteraction) {
	const runtime = formsRuntime();
	const segments = interaction.customId.split(':');
	const kind = segments[2];
	const ownerId = ['submissions', 'preview', 'repair', 'recreate'].includes(kind!)
		? segments[4]
		: segments[3];

	if (ownerId !== interaction.user.id) {
		throw new FormError(
			'This panel belongs to someone else. Run the command yourself to open your own panel.'
		);
	}

	await interaction.deferUpdate();

	if (kind === 'mine') {
		if (interaction.inGuild()) {
			throw new FormError('You can see your submissions in your DMs with the bot.');
		}

		await interaction.editReply(
			await runtime.browsing.applicantSubmissions(ownerId, Number(segments[4]))
		);
		return;
	}

	const guild = interaction.guild;

	if (!guild) {
		throw new FormError('Use this in the server it belongs to.');
	}

	if (kind === 'forms') {
		await interaction.editReply(
			await runtime.browsing.forms(guild, ownerId, Number(segments[4]))
		);
		return;
	}

	if (kind === 'read') {
		await interaction.editReply(
			await runtime.browsing.submissionForms(guild, ownerId, Number(segments[4]))
		);
		return;
	}

	if (kind === 'readopen') {
		if (!interaction.isStringSelectMenu()) {
			throw new FormError(outdatedControl);
		}

		await interaction.editReply(
			await runtime.browsing.submissions(guild, interaction.values[0]!, ownerId)
		);
		return;
	}

	if (kind === 'repair' || kind === 'recreate') {
		await runtime.recovery.handle(interaction, guild, ownerId, segments);
		return;
	}

	const formId =
		kind === 'open' && interaction.isStringSelectMenu() ? interaction.values[0] : segments[3];
	const form = await runtime.formService.findForm(formId!);

	if (form.guildId !== guild.id) {
		throw new FormError('This form belongs to another server.');
	}

	if (kind === 'submissions') {
		await interaction.editReply(
			await runtime.browsing.submissions(guild, form.id, ownerId, Number(segments[5]))
		);
		return;
	}

	await runtime.browsing.assertManagement(guild, ownerId);

	if (kind === 'preview') {
		if (form.data.revision !== Number(segments[5])) {
			throw new FormError(
				'This form was just edited. Press Preview again to see the latest version.'
			);
		}

		await interaction.editReply(
			await runtime.browsing.preview(form, ownerId, Number(segments[6]))
		);
		return;
	}

	if (kind !== 'open') {
		throw new FormError(outdatedControl);
	}

	await interaction.editReply(managePanel(form, ownerId));
}

export async function routeFormInteraction(interaction: FormInteraction) {
	try {
		const runtime = formsRuntime();
		await runtime.rateLimits.enforce(interaction.user.id, 'interaction');
		const route = interaction.customId.split(':')[1];

		if (route === 'b') {
			if (interaction.isModalSubmit()) {
				throw new FormError(outdatedControl);
			}

			await browse(interaction);
			return;
		}

		if (route === 'p') {
			if (interaction.isModalSubmit()) {
				throw new FormError(outdatedControl);
			}

			await runtime.staffPanel.handle(interaction);
			return;
		}

		if (route === 'r') {
			const [, , submissionId, action] = interaction.customId.split(':');
			const submission = await runtime.formService.findSubmission(submissionId!);

			if (
				!interaction.guild ||
				!interaction.channelId ||
				interaction.guildId !== submission.guildId ||
				interaction.channelId !== submission.threadId
			) {
				throw new FormError('Use these buttons in the submission thread.');
			}

			if (action !== 'accepted' && action !== 'rejected') {
				throw new FormError(outdatedControl);
			}

			const identity = await runtime.permissions.identify(
				interaction.guild,
				interaction.user.id
			);
			await runtime.permissions.assertAllowed(
				submission.guildId,
				'submissions.decide',
				identity
			);

			if (interaction.isButton()) {
				if (submission.status !== 'pending') {
					throw new FormError(`This submission was already ${submission.status}.`);
				}

				await interaction.showModal(
					new ModalBuilder()
						.setCustomId(interaction.customId)
						.setTitle(action === 'accepted' ? 'Accept submission' : 'Reject submission')
						.addLabelComponents(
							new LabelBuilder()
								.setLabel('Reason sent to the applicant')
								.setTextInputComponent(
									new TextInputBuilder()
										.setCustomId('reason')
										.setStyle(TextInputStyle.Paragraph)
										.setMaxLength(1000)
										.setRequired(true)
								)
						)
				);
				return;
			}

			if (!interaction.isModalSubmit()) {
				throw new FormError(outdatedControl);
			}

			await interaction.deferReply({ flags: MessageFlags.Ephemeral });

			await runtime.formService.recordDecision(
				submission.id,
				interaction.user.id,
				interaction.channelId,
				action,
				interaction.fields.getTextInputValue('reason'),
				identity
			);
			await interaction.editReply(
				'Decision saved. Applicant notification and thread archival are queued.'
			);
			return;
		}

		if (route === 's' || route === 'directory') {
			if (
				interaction.isModalSubmit() ||
				(!interaction.isButton() && !interaction.isStringSelectMenu())
			) {
				throw new FormError(outdatedControl);
			}

			if (route === 'directory' && interaction.customId.split(':')[2] === 'status') {
				if (interaction.inGuild()) {
					throw new FormError('You can see your submissions in your DMs with the bot.');
				}

				await interaction.deferUpdate();
				await interaction.editReply(
					await runtime.browsing.applicantSubmissions(interaction.user.id)
				);
				return;
			}

			await runtime.applicants.handleInteraction(interaction);
			void runtime.delivery.wake();
			return;
		}

		await runtime.builder.handleInteraction(interaction);
	} catch (error) {
		if (interaction.deferred || interaction.replied) {
			const segments = interaction.customId.split(':');
			const isOwnedEditor =
				interaction.inGuild() &&
				['m', 'type', 'question', 'config', 'qsave', 'access', 'qe', 'limits'].includes(
					segments[1]!
				) &&
				segments[3] === interaction.user.id;
			const controls = isOwnedEditor
				? [
						buttons(
							button(
								`zf:m:${segments[2]}:${interaction.user.id}:back`,
								'Back to form'
							)
						)
					]
				: [];
			await interaction.editReply(errorPanel(error, controls));
		} else {
			await interaction.reply({
				...errorPanel(error),
				flags: interaction.inGuild()
					? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
					: MessageFlags.IsComponentsV2
			});
		}
	}
}
