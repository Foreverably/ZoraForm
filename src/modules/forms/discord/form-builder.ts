import { QuestionEditor, questionEditorPanel } from './question-editor';
import { StaffPermissions } from '../services/staff-permissions';
import { FormBrowsing } from './browsing';
import type { StaffCapability } from '../domain/permissions';
import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	LabelBuilder,
	ChannelSelectMenuBuilder,
	ChannelType,
	type ButtonInteraction,
	type AnySelectMenuInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { FormService } from '../services/form-service';
import { DiscordDelivery } from './delivery-worker';
import { formQuestionSchema, discordSnowflakeSchema } from '../domain/schemas';
import { FormError, outdatedControl } from '../domain/rules';
import type { FormConfiguration } from '../domain/types';
import { accessPanel, blacklistSubject, readAccessChange, updateAccessList } from './access-panel';
import { limitsPanel, updateLimit } from './limits-panel';
import { managePanel, panel, buttons, button, withoutNumbering } from './components';

type BuilderInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;
interface ModalField {
	id: string;
	label: string;
	value?: string;
	multiline?: boolean;
	required?: boolean;
}

function modal(customId: string, title: string, fields: ModalField[]) {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(title)
		.addLabelComponents(
			fields.map((field) =>
				new LabelBuilder().setLabel(field.label).setTextInputComponent(
					new TextInputBuilder()
						.setCustomId(field.id)
						.setStyle(field.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
						.setRequired(field.required !== false)
						.setMaxLength(
							field.id === 'choices' ? 2524 : field.id === 'prompt' ? 300 : 1000
						)
						.setValue(field.value ?? '')
				)
			)
		);
}

export class FormBuilder {
	private readonly questionEditor: QuestionEditor;

	public constructor(
		private readonly formService: FormService,
		private readonly delivery: DiscordDelivery,
		private readonly permissions: StaffPermissions,
		private readonly browsing: FormBrowsing
	) {
		this.questionEditor = new QuestionEditor(formService, delivery.questionMedia);
	}

	public async handleInteraction(interaction: BuilderInteraction) {
		const guild = interaction.guild;

		if (!guild) {
			throw new FormError('Use this in a server, not in DMs.');
		}

		const identity = await this.permissions.identify(guild, interaction.user.id);
		const segments = interaction.customId.split(':');
		const requestedAction =
			segments[1] === 'config' ? segments[4] : segments[1] === 'm' ? segments[4] : 'edit';
		const capability: StaffCapability =
			requestedAction === 'publish'
				? 'forms.publish'
				: requestedAction === 'archive'
					? 'forms.archive'
					: segments[1] === 'access' && blacklistSubject(segments[4])
						? 'forms.blacklist'
						: 'forms.edit';
		const isNavigation =
			segments[1] === 'm' && (segments[4] === 'back' || segments[4] === 'access');

		if (isNavigation) {
			await this.browsing.assertManagement(guild, interaction.user.id);
		} else {
			await this.permissions.assertAllowed(guild.id, capability, identity);
		}

		const formId = segments[2]!;
		const panelOwnerId = segments[3];

		if (panelOwnerId !== interaction.user.id) {
			throw new FormError(
				'This panel belongs to someone else. Run /form list to open your own panel.'
			);
		}

		const form = await this.formService.findForm(formId);

		if (form.guildId !== guild.id) {
			throw new FormError('This form belongs to another server.');
		}

		if (segments[1] === 'qe') {
			await this.questionEditor.handle(interaction, form, segments);
			return;
		}

		if (interaction.isModalSubmit()) {
			if (!interaction.isFromMessage()) {
				throw new FormError('Open this from the form panel, then try again.');
			}

			await interaction.deferUpdate();
			await this.saveModal(interaction, segments);
			const updatedForm = await this.formService.findForm(formId);
			await interaction.editReply(
				segments[1] === 'qsave'
					? questionEditorPanel(
							updatedForm,
							interaction.user.id,
							updatedForm.data.questions.length - 1
						)
					: managePanel(updatedForm, interaction.user.id)
			);
			return;
		}

		if (segments[1] === 'access') {
			if (!interaction.isAnySelectMenu()) {
				throw new FormError(outdatedControl);
			}

			await interaction.deferUpdate();
			const change = readAccessChange(interaction, segments, form.data);
			const subject = blacklistSubject(change.category);

			if (subject) {
				await this.formService.changeFormBlacklist(
					formId,
					guild.id,
					interaction.user.id,
					subject,
					change,
					change.revision
				);
			} else {
				await this.formService.editFormDraft(
					formId,
					guild.id,
					interaction.user.id,
					(configuration) => updateAccessList(configuration, change)
				);
			}

			await interaction.editReply(
				accessPanel(await this.formService.findForm(formId), interaction.user.id)
			);
			return;
		}

		if (segments[1] === 'limits' && interaction.isStringSelectMenu()) {
			const selectedValue = interaction.values[0];
			await interaction.deferUpdate();
			await this.formService.editFormDraft(
				formId,
				guild.id,
				interaction.user.id,
				(configuration) => updateLimit(configuration, segments, selectedValue)
			);
			await interaction.editReply(
				limitsPanel(await this.formService.findForm(formId), interaction.user.id)
			);
			return;
		}

		if (segments[1] === 'type' && interaction.isStringSelectMenu()) {
			const questionType = interaction.values[0]!;
			await interaction.showModal(
				this.questionModal(formId, interaction.user.id, Number(segments[4]), questionType)
			);
			return;
		}

		if (segments[1] === 'question' && interaction.isStringSelectMenu()) {
			const questionIndex = Number(interaction.values[0]);
			const revision = Number(segments[5]);
			const question = form.data.questions[questionIndex];

			if (!question || form.data.revision !== revision) {
				throw new FormError(
					'The questions changed while this panel was open. Open the form again from /form list.'
				);
			}

			await interaction.deferUpdate();

			if (segments[4] === 'edit') {
				await interaction.editReply(
					questionEditorPanel(form, interaction.user.id, questionIndex)
				);
				return;
			}

			await this.formService.editFormDraft(
				formId,
				guild.id,
				interaction.user.id,
				(configuration) => {
					this.assertRevision(configuration, revision);
					return {
						...configuration,
						questions: configuration.questions.filter(
							(_, index) => index !== questionIndex
						)
					};
				}
			);
			await interaction.editReply(
				managePanel(await this.formService.findForm(formId), interaction.user.id)
			);
			return;
		}

		const action = segments[4]!;
		const modalId = `zf:config:${formId}:${interaction.user.id}:${action}:${form.data.revision}`;

		if (action === 'details') {
			await interaction.showModal(
				modal(modalId, 'Form details', [
					{ id: 'name', label: 'Name', value: form.data.name },
					{
						id: 'description',
						label: 'Description',
						value: form.data.description,
						multiline: true,
						required: false
					}
				])
			);
			return;
		}

		if (action === 'access') {
			await interaction.deferUpdate();
			await interaction.editReply(accessPanel(form, interaction.user.id));
			return;
		}

		if (action === 'policy') {
			await interaction.deferUpdate();
			await interaction.editReply(limitsPanel(form, interaction.user.id));
			return;
		}

		if (action === 'review') {
			await interaction.showModal(
				new ModalBuilder()
					.setCustomId(modalId)
					.setTitle('Staff review')
					.addLabelComponents(
						new LabelBuilder()
							.setLabel('Submission channel')
							.setDescription('Channel permissions control who can read submissions.')
							.setChannelSelectMenuComponent(
								new ChannelSelectMenuBuilder()
									.setCustomId('channel')
									.setChannelTypes(ChannelType.GuildText)
									.setDefaultChannels(form.data.reviewChannelId)
									.setMinValues(1)
									.setMaxValues(1)
							)
					)
			);
			return;
		}

		if (action === 'order') {
			await interaction.showModal(
				modal(modalId, 'Reorder questions', [
					{
						id: 'order',
						label: 'Question numbers in the new order (e.g. 2,1,3)',
						value: form.data.questions.map((_, index) => index + 1).join(',')
					}
				])
			);
			return;
		}

		await interaction.deferUpdate();

		if (action === 'add') {
			await interaction.editReply(
				panel('Choose the kind of question to add.', [
					new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						new StringSelectMenuBuilder()
							.setCustomId(
								`zf:type:${formId}:${interaction.user.id}:${form.data.revision}`
							)
							.setPlaceholder('Question type')
							.addOptions(
								['text', 'number', 'choice', 'attachment'].map((type) => ({
									label: type[0]!.toUpperCase() + type.slice(1),
									value: type
								}))
							)
					),
					buttons(button(`zf:m:${formId}:${interaction.user.id}:back`, 'Back to form'))
				])
			);
			return;
		}

		if (action === 'edit' || action === 'remove') {
			if (!form.data.questions.length) {
				throw new FormError('Add a question first.');
			}

			await interaction.editReply(
				panel(`Choose a question to ${action}.`, [
					new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						new StringSelectMenuBuilder()
							.setCustomId(
								`zf:question:${formId}:${interaction.user.id}:${action}:${form.data.revision}`
							)
							.setPlaceholder('Choose a question')
							.addOptions(
								form.data.questions.map((question, index) => ({
									label: `${index + 1}. ${withoutNumbering(question.prompt)}`.slice(
										0,
										100
									),
									value: String(index)
								}))
							)
					),
					buttons(button(`zf:m:${formId}:${interaction.user.id}:back`, 'Back to form'))
				])
			);
			return;
		}

		if (action === 'publish') {
			await this.delivery.validateReviewChannel(guild.id, form.data);
			await this.delivery.questionMedia.assertAvailable(form.data.questions);
			await guild.roles.fetch();

			for (const roleId of [
				...form.data.allowRoles,
				...form.data.denyRoles,
				...form.data.requiredRoles
			]) {
				if (!guild.roles.cache.has(roleId)) {
					throw new FormError(
						`A role on this form was deleted (ID ${roleId}). Remove it in Access before publishing.`
					);
				}
			}

			await this.formService.publishForm(
				formId,
				guild.id,
				interaction.user.id,
				form.data.revision
			);
		} else if (action === 'archive') {
			await this.formService.archiveForm(formId, guild.id, interaction.user.id);
		} else if (action === 'preview') {
			await interaction.editReply(await this.browsing.preview(form, interaction.user.id));
			return;
		}

		await interaction.editReply(
			managePanel(await this.formService.findForm(formId), interaction.user.id)
		);
	}

	private assertRevision(configuration: FormConfiguration, revision: number) {
		if (configuration.revision !== revision) {
			throw new FormError(
				'This form changed while this panel was open. Open it again from /form list.'
			);
		}
	}

	private questionModal(formId: string, actorId: string, revision: number, questionType: string) {
		if (!['text', 'number', 'choice', 'attachment'].includes(questionType)) {
			throw new FormError(outdatedControl);
		}

		const fields: ModalField[] = [{ id: 'prompt', label: 'Question wording', multiline: true }];

		if (questionType === 'choice') {
			fields.push({
				id: 'choices',
				label: 'Answer choices (one per line, 2–25 choices)',
				multiline: true
			});
		}

		return modal(
			`zf:qsave:${formId}:${actorId}:${revision}:${questionType}`,
			'Add question',
			fields
		);
	}

	private async saveModal(interaction: ModalSubmitInteraction, segments: string[]) {
		const formId = segments[2]!;
		const value = (fieldId: string) => interaction.fields.getTextInputValue(fieldId).trim();

		if (segments[1] === 'qsave') {
			const revision = Number(segments[4]);
			const questionType = segments[5]!;
			const question = formQuestionSchema.parse({
				id: randomUUID(),
				type: questionType,
				prompt: value('prompt'),
				...(questionType === 'choice'
					? {
							options: value('choices')
								.split('\n')
								.map((choice) => choice.trim())
								.filter(Boolean)
						}
					: {})
			});

			await this.formService.editFormDraft(
				formId,
				interaction.guildId!,
				interaction.user.id,
				(configuration) => {
					this.assertRevision(configuration, revision);
					return { ...configuration, questions: [...configuration.questions, question] };
				}
			);
			return;
		}

		const action = segments[4];
		const revision = Number(segments[5]);

		await this.formService.editFormDraft(
			formId,
			interaction.guildId!,
			interaction.user.id,
			(configuration) => {
				this.assertRevision(configuration, revision);

				if (action === 'details') {
					return {
						...configuration,
						name: value('name'),
						description: value('description')
					};
				}
				if (action === 'review') {
					return {
						...configuration,
						reviewChannelId: discordSnowflakeSchema.parse(
							interaction.fields.getSelectedChannels('channel', true).first()!.id
						)
					};
				}

				if (action === 'order') {
					const order = value('order')
						.split(',')
						.map((number) => Number(number.trim()) - 1);

					if (
						order.length !== configuration.questions.length ||
						new Set(order).size !== order.length ||
						order.some(
							(index) => !Number.isInteger(index) || !configuration.questions[index]
						)
					) {
						throw new FormError('List every question number exactly once, like 2,1,3.');
					}

					return {
						...configuration,
						questions: order.map((index) => configuration.questions[index]!)
					};
				}

				throw new FormError(outdatedControl);
			}
		);
	}
}
