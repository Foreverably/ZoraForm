import {
	ButtonStyle,
	FileUploadBuilder,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	messageLink,
	type ButtonInteraction,
	type AnySelectMenuInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import type { FormQuestion, FormRecord, QuestionReference } from '../domain/types';
import { describeNumberLimits, describeTextLimits, FormError, numberLimits } from '../domain/rules';
import { FormService } from '../services/form-service';
import { QuestionMedia } from '../services/question-media';
import { button, buttons, panel, safe } from './components';

type EditorInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

export function questionEditorPanel(form: FormRecord, actorId: string, questionIndex: number) {
	const question = form.data.questions[questionIndex];

	if (!question) {
		throw new FormError('That question no longer exists. Return to the form.');
	}

	const controlId = (action: string) =>
		`zf:qe:${form.id}:${actorId}:${questionIndex}:${form.data.revision}:${action}`;
	const settingButtons = [
		button(controlId('prompt'), 'Edit wording', ButtonStyle.Primary),
		button(controlId('required'), question.required ? 'Make optional' : 'Make required')
	];
	let details = '';

	if (question.type === 'text') {
		const limits = describeTextLimits(question);
		details = `**Answer:** ${limits[0]!.toUpperCase()}${limits.slice(1)}\n`;
		settingButtons.push(button(controlId('limits'), 'Answer limits'));
	}

	if (question.type === 'number') {
		const limits = describeNumberLimits(question);
		details = `**Answer:** A number${limits ? ` ${limits}` : ''}\n`;
		settingButtons.push(button(controlId('limits'), 'Answer limits'));
	}

	if (question.type === 'choice') {
		const choices = question.options
			.map((choice, index) => `${index + 1}. ${safe(choice)}`)
			.join('\n');
		details = `**Choices:**\n${choices.length > 2400 ? `${choices.slice(0, 2400)}…` : choices}\n`;
		settingButtons.push(button(controlId('choices'), 'Edit choices'));
	}

	const references = question.references ?? [];
	const fileLinks = references
		.map(
			(reference) =>
				`[${safe(reference.name.replace(/[[\]]/g, ''))}](${messageLink(reference.channelId, reference.messageId, form.guildId)})`
		)
		.join(', ');
	const typeLabel = `${question.type[0]!.toUpperCase()}${question.type.slice(1)}`;
	const wording = question.prompt
		.split('\n')
		.map((line) => `> ${safe(line)}`)
		.join('\n');

	return panel(
		`## Question ${questionIndex + 1} of ${form.data.questions.length}\n-# ${typeLabel} · ${question.required ? 'Required' : 'Optional'}\n\n${wording}\n\n${details}**Reference files:** ${fileLinks || 'None'}\n\n-# Changes stay in the draft until you publish.`,
		[
			buttons(...settingButtons),
			buttons(
				button(
					controlId('upload'),
					references.length ? 'Replace files' : 'Reference files'
				),
				...(references.length ? [button(controlId('clear'), 'Remove files')] : [])
			),
			buttons(
				button(`zf:m:${form.id}:${actorId}:preview`, 'Preview form'),
				button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')
			)
		]
	);
}

export class QuestionEditor {
	public constructor(
		private readonly formService: FormService,
		private readonly media: QuestionMedia
	) {}

	public async handle(interaction: EditorInteraction, form: FormRecord, segments: string[]) {
		const questionIndex = Number(segments[4]);
		const revision = Number(segments[5]);
		const action = segments[6];
		const question = form.data.questions[questionIndex];

		if (!Number.isInteger(questionIndex) || !question || form.data.revision !== revision) {
			throw new FormError('This question changed. Reopen it from the form panel.');
		}

		if (
			!interaction.isModalSubmit() &&
			['prompt', 'limits', 'choices', 'upload'].includes(action!)
		) {
			await interaction.showModal(this.editModal(interaction.customId, action!, question));
			return;
		}

		if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
			throw new FormError('Open the question editor from its form panel.');
		}

		await interaction.deferUpdate();
		let newReferences: QuestionReference[] = [];

		if (action === 'upload' && interaction.isModalSubmit()) {
			newReferences = await this.media.capture(form.guildId, form.data.reviewChannelId, [
				...interaction.fields.getUploadedFiles('references', true).values()
			]);
		}

		try {
			await this.formService.editFormDraft(
				form.id,
				form.guildId,
				interaction.user.id,
				(configuration) => {
					if (configuration.revision !== revision) {
						throw new FormError(
							'This question changed. Reopen it from the form panel.'
						);
					}

					const questions = [...configuration.questions];
					const current = questions[questionIndex]!;
					const value = (field: string) => {
						if (!interaction.isModalSubmit()) {
							throw new FormError('Save this setting through its editor.');
						}

						return interaction.fields.getTextInputValue(field).trim();
					};

					switch (action) {
						case 'prompt':
							questions[questionIndex] = { ...current, prompt: value('prompt') };
							break;
						case 'required':
							questions[questionIndex] = { ...current, required: !current.required };
							break;
						case 'limits':
							if (current.type !== 'text' && current.type !== 'number')
								throw new FormError('This question has no numeric limits.');
							if (current.type === 'text') {
								questions[questionIndex] = {
									...current,
									min: Number(value('minimum')),
									max: Number(value('maximum'))
								};
							} else {
								questions[questionIndex] = {
									...current,
									min: this.optionalLimit(value('minimum')),
									max: this.optionalLimit(value('maximum'))
								};
							}
							break;
						case 'choices':
							if (current.type !== 'choice')
								throw new FormError('Only choice questions have choices.');
							questions[questionIndex] = {
								...current,
								options: value('choices')
									.split('\n')
									.map((choice) => choice.trim())
									.filter(Boolean)
							};
							break;
						case 'upload':
							if (!newReferences.length)
								throw new FormError(
									'Upload reference files through the file picker.'
								);
							questions[questionIndex] = { ...current, references: newReferences };
							break;
						case 'clear':
							questions[questionIndex] = { ...current, references: [] };
							break;
						default:
							throw new FormError('Unknown question setting.');
					}

					return { ...configuration, questions };
				}
			);
		} catch (error) {
			if (newReferences.length) {
				await this.media.discard(newReferences).catch(() => undefined);
			}

			throw error;
		}

		await interaction.editReply(
			questionEditorPanel(
				await this.formService.findForm(form.id),
				interaction.user.id,
				questionIndex
			)
		);
	}

	private optionalLimit(input: string) {
		if (input === '') {
			return null;
		}

		const limit = Number(input);

		if (!Number.isFinite(limit)) {
			throw new FormError('Limits must be numbers, such as 18 or 2.5.');
		}

		return limit;
	}

	private editModal(customId: string, action: string, question: FormQuestion) {
		const modal = new ModalBuilder().setCustomId(customId).setTitle('Edit question');
		const textField = (id: string, label: string, value: string, multiline = false) =>
			new LabelBuilder().setLabel(label).setTextInputComponent(
				new TextInputBuilder()
					.setCustomId(id)
					.setValue(value)
					.setStyle(multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
					.setMaxLength(id === 'prompt' ? 300 : id === 'choices' ? 2524 : 30)
			);
		const optionalLimitField = (id: string, label: string, limit: number | null) => {
			const input = new TextInputBuilder()
				.setCustomId(id)
				.setStyle(TextInputStyle.Short)
				.setMaxLength(30)
				.setRequired(false);

			if (limit !== null) {
				input.setValue(String(limit));
			}

			return new LabelBuilder().setLabel(label).setTextInputComponent(input);
		};

		if (action === 'upload') {
			return modal
				.setTitle('Question reference files')
				.addLabelComponents(
					new LabelBuilder()
						.setLabel('Screenshots or documents')
						.setDescription(
							'1–3 files, up to 8 MiB each and 20 MiB total. Replaces existing reference files.'
						)
						.setFileUploadComponent(
							new FileUploadBuilder()
								.setCustomId('references')
								.setMinValues(1)
								.setMaxValues(3)
								.setRequired(true)
						)
				);
		}

		if (action === 'prompt') {
			return modal.addLabelComponents(
				textField('prompt', 'Question wording', question.prompt, true)
			);
		}

		if (action === 'choices' && question.type === 'choice') {
			return modal.addLabelComponents(
				textField(
					'choices',
					'Answer choices (one per line)',
					question.options.join('\n'),
					true
				)
			);
		}

		if (action === 'limits' && question.type === 'text') {
			return modal.addLabelComponents(
				textField('minimum', 'Minimum characters', String(question.min)),
				textField('maximum', 'Maximum characters (up to 2,000)', String(question.max))
			);
		}

		if (action === 'limits' && question.type === 'number') {
			const { min, max } = numberLimits(question);

			return modal.addLabelComponents(
				optionalLimitField('minimum', 'Lowest number (empty for no limit)', min),
				optionalLimitField('maximum', 'Highest number (empty for no limit)', max)
			);
		}

		throw new FormError('This setting is unavailable for this question type.');
	}
}
