import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	PermissionFlagsBits,
	MessageFlags,
	type ButtonInteraction,
	type StringSelectMenuInteraction,
	type ModalSubmitInteraction,
	type Guild
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { FormService } from '../services/form-service';
import { DiscordDelivery } from './delivery-worker';
import { formQuestionSchema, discordSnowflakeSchema } from '../domain/schemas';
import { FormError } from '../domain/rules';
import type { FormConfiguration, FormQuestion } from '../domain/types';
import { managePanel, panel, safe } from './components';

type BuilderInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
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
		.addComponents(
			fields.map((field) =>
				new ActionRowBuilder<TextInputBuilder>().addComponents(
					new TextInputBuilder()
						.setCustomId(field.id)
						.setLabel(field.label.slice(0, 45))
						.setStyle(field.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
						.setRequired(field.required !== false)
						.setMaxLength(field.id === 'choices' ? 2500 : 1000)
						.setValue(field.value ?? '')
				)
			)
		);
}

function parseIds(value: string) {
	const identifiers = value.split(/[\s,]+/).filter(Boolean);

	if (identifiers.length > 100) {
		throw new FormError('Use no more than 100 IDs in each list.');
	}

	return [...new Set(identifiers.map((identifier) => discordSnowflakeSchema.parse(identifier)))];
}

export async function requireFormAdmin(guild: Guild | null, userId: string) {
	if (!guild) {
		throw new FormError('Manage forms from a server.');
	}

	const member = await guild.members.fetch({ user: userId, force: true });

	if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
		throw new FormError('You need Manage Server permission to manage forms.');
	}

	return guild;
}

export class FormBuilder {
	public constructor(
		private readonly formService: FormService,
		private readonly delivery: DiscordDelivery
	) {}

	public async handleInteraction(interaction: BuilderInteraction) {
		const guild = await requireFormAdmin(interaction.guild, interaction.user.id);
		const segments = interaction.customId.split(':');
		const formId = segments[2]!;
		const panelOwnerId = segments[3];

		if (panelOwnerId !== interaction.user.id) {
			throw new FormError('Open your own panel with /form manage.');
		}

		const form = await this.formService.findForm(formId);

		if (form.guildId !== guild.id) {
			throw new FormError('This form belongs to another server.');
		}

		if (interaction.isModalSubmit()) {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await this.saveModal(interaction, segments, form.data);
			await interaction.editReply(
				managePanel(await this.formService.findForm(formId), interaction.user.id)
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
				throw new FormError('The question list changed. Reopen /form manage.');
			}

			if (segments[4] === 'edit') {
				await interaction.showModal(
					this.questionModal(
						formId,
						interaction.user.id,
						revision,
						question.type,
						question,
						questionIndex
					)
				);
				return;
			}

			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
			await interaction.showModal(
				modal(modalId, 'Applicant access', [
					{
						id: 'allow',
						label: 'Allowed role IDs (any; blank for everyone)',
						value: form.data.allowRoles.join(', '),
						required: false
					},
					{
						id: 'deny',
						label: 'Denied role IDs (always deny)',
						value: form.data.denyRoles.join(', '),
						required: false
					},
					{
						id: 'require',
						label: 'Required role IDs (all)',
						value: form.data.requiredRoles.join(', '),
						required: false
					},
					{
						id: 'blacklist',
						label: 'Blocked user IDs for this form',
						value: form.data.blacklist.join(', '),
						required: false
					}
				])
			);
			return;
		}

		if (action === 'policy') {
			await interaction.showModal(
				modal(modalId, 'Submission policy', [
					{
						id: 'total',
						label: 'Lifetime submissions per user (0 = unlimited)',
						value: String(form.data.totalLimit)
					},
					{
						id: 'pending',
						label: 'Pending submissions per user (0 = unlimited)',
						value: String(form.data.pendingLimit)
					},
					{
						id: 'cooldown',
						label: 'Cooldown in seconds (0 = none)',
						value: String(form.data.cooldownSeconds)
					},
					{
						id: 'retention',
						label: 'Keep submitted answers for days (1–365)',
						value: String(form.data.retentionDays)
					}
				])
			);
			return;
		}

		if (action === 'review') {
			await interaction.showModal(
				modal(modalId, 'Staff review', [
					{
						id: 'channel',
						label: 'Private review parent channel ID',
						value: form.data.reviewChannelId
					},
					{
						id: 'reviewers',
						label: 'Reviewer user IDs, separated by commas',
						value: form.data.reviewerIds.join(', ')
					}
				])
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

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
					)
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
									label: `${index + 1}. ${question.prompt}`.slice(0, 100),
									value: String(index)
								}))
							)
					)
				])
			);
			return;
		}

		if (action === 'publish') {
			await this.delivery.validateReviewChannel(guild.id, form.data);
			await guild.roles.fetch();

			for (const roleId of [
				...form.data.allowRoles,
				...form.data.denyRoles,
				...form.data.requiredRoles
			]) {
				if (!guild.roles.cache.has(roleId)) {
					throw new FormError(
						`Role ${roleId} no longer exists. Update Access before publishing.`
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
			const preview = form.data.questions
				.slice(0, 10)
				.map(
					(question, index) =>
						`${index + 1}. ${safe(question.prompt)}\nType: ${question.type} · ${question.required ? 'required' : 'optional'}`
				)
				.join('\n\n');
			await interaction.editReply(
				panel(
					`## Preview: ${safe(form.data.name)}\n${safe(form.data.description)}\n\n${preview || 'No questions yet.'}\n\nShowing up to ten questions. ${form.data.questions.length} total.`
				)
			);
			return;
		}

		await interaction.editReply(
			managePanel(await this.formService.findForm(formId), interaction.user.id)
		);
	}

	private assertRevision(configuration: FormConfiguration, revision: number) {
		if (configuration.revision !== revision) {
			throw new FormError(
				'The draft changed while this panel was open. Reopen /form manage.'
			);
		}
	}

	private questionModal(
		formId: string,
		actorId: string,
		revision: number,
		questionType: string,
		question?: FormQuestion,
		questionIndex?: number
	) {
		if (!['text', 'number', 'choice', 'attachment'].includes(questionType)) {
			throw new FormError('Choose a supported question type.');
		}

		const fields: ModalField[] = [
			{ id: 'prompt', label: 'Question', value: question?.prompt ?? '', multiline: true },
			{
				id: 'required',
				label: 'Is an answer required? (yes/no)',
				value: question?.required === false ? 'no' : 'yes'
			}
		];

		if (questionType === 'choice') {
			fields.push({
				id: 'choices',
				label: 'Answer choices (one per line, 2–25 choices)',
				value: question?.type === 'choice' ? question.options.join('\n') : '',
				multiline: true
			});
		}

		if (questionType === 'text' || questionType === 'number') {
			fields.push(
				{
					id: 'minimum',
					label: questionType === 'text' ? 'Minimum characters' : 'Minimum value',
					value: String(
						question && (question.type === 'text' || question.type === 'number')
							? question.min
							: questionType === 'text'
								? 1
								: 0
					)
				},
				{
					id: 'maximum',
					label:
						questionType === 'text'
							? 'Maximum characters (up to 2,000)'
							: 'Maximum value',
					value: String(
						question && (question.type === 'text' || question.type === 'number')
							? question.max
							: questionType === 'text'
								? 2000
								: 1000000
					)
				}
			);
		}

		if (questionType === 'number') {
			fields.push({
				id: 'integer',
				label: 'Whole numbers only? (yes/no)',
				value: question?.type === 'number' && question.integer ? 'yes' : 'no'
			});
		}

		const operation = questionIndex === undefined ? 'add' : String(questionIndex);
		return modal(
			`zf:qsave:${formId}:${actorId}:${revision}:${questionType}:${operation}`,
			question ? 'Edit question' : 'Add question',
			fields
		);
	}

	private async saveModal(
		interaction: ModalSubmitInteraction,
		segments: string[],
		currentConfiguration: FormConfiguration
	) {
		const formId = segments[2]!;
		const value = (fieldId: string) => interaction.fields.getTextInputValue(fieldId).trim();

		if (segments[1] === 'qsave') {
			const revision = Number(segments[4]);
			const questionType = segments[5]!;
			const questionIndex = segments[6] === 'add' ? undefined : Number(segments[6]);
			const required = value('required').toLowerCase();

			if (required !== 'yes' && required !== 'no') {
				throw new FormError('Required must be yes or no.');
			}

			const question = formQuestionSchema.parse({
				id:
					questionIndex === undefined
						? randomUUID()
						: currentConfiguration.questions[questionIndex]?.id,
				type: questionType,
				prompt: value('prompt'),
				required: required === 'yes',
				...(questionType === 'choice'
					? {
							options: value('choices')
								.split('\n')
								.map((choice) => choice.trim())
								.filter(Boolean)
						}
					: {}),
				...(questionType === 'text' || questionType === 'number'
					? { min: Number(value('minimum')), max: Number(value('maximum')) }
					: {}),
				...(questionType === 'number'
					? { integer: value('integer').toLowerCase() === 'yes' }
					: {})
			});

			await this.formService.editFormDraft(
				formId,
				interaction.guildId!,
				interaction.user.id,
				(configuration) => {
					this.assertRevision(configuration, revision);
					const questions = [...configuration.questions];

					if (questionIndex === undefined) {
						questions.push(question);
					} else {
						questions[questionIndex] = question;
					}

					return { ...configuration, questions };
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
				if (action === 'access') {
					return {
						...configuration,
						allowRoles: parseIds(value('allow')),
						denyRoles: parseIds(value('deny')),
						requiredRoles: parseIds(value('require')),
						blacklist: parseIds(value('blacklist'))
					};
				}
				if (action === 'policy') {
					return {
						...configuration,
						totalLimit: Number(value('total')),
						pendingLimit: Number(value('pending')),
						cooldownSeconds: Number(value('cooldown')),
						retentionDays: Number(value('retention'))
					};
				}
				if (action === 'review') {
					return {
						...configuration,
						reviewChannelId: discordSnowflakeSchema.parse(value('channel')),
						reviewerIds: parseIds(value('reviewers'))
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
						throw new FormError('List every question number exactly once.');
					}

					return {
						...configuration,
						questions: order.map((index) => configuration.questions[index]!)
					};
				}

				throw new FormError('Unknown form setting.');
			}
		);
	}
}
