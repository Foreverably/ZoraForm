import {
	ButtonStyle,
	FileUploadBuilder,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type AnySelectMenuInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import type { FormQuestion, FormRecord, QuestionReference } from '../domain/types';
import { FormError } from '../domain/rules';
import { FormService } from '../services/form-service';
import { QuestionMedia } from '../services/question-media';
import { button, buttons, panel, safe, type Row } from './components';

type EditorInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

export function questionEditorPanel(form: FormRecord, actorId: string, questionIndex: number) {
	const question = form.data.questions[questionIndex];

	if (!question) {
		throw new FormError('That question no longer exists. Return to the form.');
	}

	const controlId = (action: string) =>
		`zf:qe:${form.id}:${actorId}:${questionIndex}:${form.data.revision}:${action}`;
	const controls: Row[] = [
		buttons(
			button(controlId('prompt'), 'Edit wording', ButtonStyle.Primary),
			button(controlId('required'), question.required ? 'Make optional' : 'Make required')
		)
	];
	let details = '';

	if (question.type === 'text' || question.type === 'number') {
		details = `\n- **${question.type === 'text' ? 'Length' : 'Range'}:** ${question.min}–${question.max}${question.type === 'text' ? ' characters' : ''}`;
		controls.push(
			buttons(
				button(controlId('limits'), 'Answer limits'),
				...(question.type === 'number'
					? [
							button(
								controlId('integer'),
								question.integer ? 'Allow decimals' : 'Whole numbers only'
							)
						]
					: [])
			)
		);
	}

	if (question.type === 'choice') {
		const choices = question.options
			.map((choice, index) => `${index + 1}. ${safe(choice)}`)
			.join('\n');
		details = `\n${choices.length > 2400 ? `${choices.slice(0, 2400)}…` : choices}`;
		controls.push(buttons(button(controlId('choices'), 'Edit choices')));
	}

	const references = question.references ?? [];
	const filenames = references.map((reference) => `- ${safe(reference.name)}`).join('\n');
	controls.push(
		buttons(
			button(controlId('upload'), references.length ? 'Replace files' : 'Reference files'),
			button(controlId('clear'), 'Remove files').setDisabled(!references.length)
		)
	);
	controls.push(
		buttons(
			button(`zf:m:${form.id}:${actorId}:preview`, 'Preview form'),
			button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')
		)
	);

	return panel(
		`## Question ${questionIndex + 1}\n-# ${question.type} · ${question.required ? 'Required' : 'Optional'}${question.type === 'number' && question.integer ? ' · Whole numbers' : ''}\n\n${safe(question.prompt)}${details}\n\n### Reference files\n${filenames || '*No reference files. Add screenshots or documents to show with this question.*'}\n\n-# Changes stay in the draft until you publish.`,
		controls
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
						case 'integer':
							if (current.type !== 'number')
								throw new FormError('Only number questions have this setting.');
							questions[questionIndex] = { ...current, integer: !current.integer };
							break;
						case 'limits':
							if (current.type !== 'text' && current.type !== 'number')
								throw new FormError('This question has no numeric limits.');
							questions[questionIndex] = {
								...current,
								min: Number(value('minimum')),
								max: Number(value('maximum'))
							};
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

		if (action === 'limits' && (question.type === 'text' || question.type === 'number')) {
			return modal.addLabelComponents(
				textField('minimum', 'Minimum', String(question.min)),
				textField('maximum', 'Maximum', String(question.max))
			);
		}

		throw new FormError('This setting is unavailable for this question type.');
	}
}
