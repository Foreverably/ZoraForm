import { ZodError } from 'zod';
import { FormError } from '../domain/rules';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	MessageFlags,
	StringSelectMenuBuilder,
	RoleSelectMenuBuilder,
	UserSelectMenuBuilder,
	TextDisplayBuilder,
	escapeMarkdown
} from 'discord.js';
import type { QuestionAnswer, FormRecord, QuestionnaireSession } from '../domain/types';

export type Row =
	| ActionRowBuilder<ButtonBuilder>
	| ActionRowBuilder<StringSelectMenuBuilder>
	| ActionRowBuilder<RoleSelectMenuBuilder | UserSelectMenuBuilder>;

export const safe = (text: string) => escapeMarkdown(text).replace(/@/g, '@\u200b');

export const button = (id: string, label: string, style = ButtonStyle.Secondary) =>
	new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

export const buttons = (...items: ButtonBuilder[]) =>
	new ActionRowBuilder<ButtonBuilder>().addComponents(items);

export function panel(text: string, rows: Row[] = []) {
	const container = new ContainerBuilder();
	container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));

	if (rows.length) {
		container.addSeparatorComponents(
			new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
		);
		container.addActionRowComponents(...rows.map((row) => row.toJSON()));
	}

	return {
		components: [container],
		flags: MessageFlags.IsComponentsV2 as const,
		allowedMentions: { parse: [] }
	};
}

export function displayAnswer(answer: QuestionAnswer | undefined) {
	if (answer == null) {
		return 'Skipped';
	}
	if (Array.isArray(answer)) {
		return answer.map((file) => safe(file.name)).join('\n');
	}
	return safe(String(answer));
}

export function answerPages(answer: QuestionAnswer | undefined) {
	const formattedAnswer = displayAnswer(answer);
	return formattedAnswer.match(/[\s\S]{1,2500}/g) ?? ['Skipped'];
}

export function summary(session: QuestionnaireSession, requestedPage = 0, requestedAnswerPage = 0) {
	const page = Math.max(0, Math.min(requestedPage, session.snapshot.questions.length - 1));
	const question = session.snapshot.questions[page]!;
	const pages = answerPages(session.answers[page]);
	const answerPage = Math.max(0, Math.min(requestedAnswerPage, pages.length - 1));
	const prefix = `zf:s:${session.id}:${session.version}`;
	const nav = buttons(
		button(`${prefix}:summary:${page - 1}`, 'Previous').setDisabled(page === 0),
		button(`${prefix}:summary:${page + 1}`, 'Next').setDisabled(
			page === session.snapshot.questions.length - 1
		),
		button(`${prefix}:edit:${page}`, 'Edit answer')
	);
	return panel(
		`## ${safe(session.snapshot.name)}\n-# Review answer ${page + 1} of ${session.snapshot.questions.length}\n\n### ${safe(question.prompt)}\n${pages[answerPage]}${pages.length > 1 ? `\n-# Answer part ${answerPage + 1} of ${pages.length}` : ''}\n\nSubmit when you are satisfied with your answers.`,
		[
			nav,
			...(pages.length > 1
				? [
						buttons(
							button(
								`${prefix}:summary:${page}:${answerPage - 1}`,
								'Earlier text'
							).setDisabled(answerPage === 0),
							button(
								`${prefix}:summary:${page}:${answerPage + 1}`,
								'More text'
							).setDisabled(answerPage === pages.length - 1)
						)
					]
				: []),
			buttons(
				button(`${prefix}:submit`, 'Submit', ButtonStyle.Success),
				button(`${prefix}:pause`, 'Pause'),
				button(`${prefix}:cancel`, 'Cancel', ButtonStyle.Danger)
			)
		]
	);
}

export function prompt(session: QuestionnaireSession) {
	if (session.position >= session.snapshot.questions.length) {
		return summary(session);
	}
	const question = session.snapshot.questions[session.position]!;
	const prefix = `zf:s:${session.id}:${session.version}`;
	let hint = 'Reply with your answer.';
	if (question.type === 'text') {
		hint = `Reply with ${question.min}–${question.max} characters.`;
	}
	if (question.type === 'number') {
		hint = `Reply with ${question.integer ? 'an integer' : 'a number'} between ${question.min} and ${question.max}.`;
	}
	if (question.type === 'choice') {
		hint = 'Select one answer below.';
	}
	if (question.type === 'attachment') {
		hint = 'Attach 1–3 files. Maximum 8 MiB each and 20 MiB total.';
	}
	const rows: Row[] = [];
	if (question.type === 'choice') {
		rows.push(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId(`${prefix}:choice`)
					.setPlaceholder('Choose an answer')
					.addOptions(
						question.options.map((label, index) => ({
							label,
							value: String(index)
						}))
					)
			)
		);
	}
	rows.push(
		buttons(
			button(`${prefix}:back`, 'Back').setDisabled(session.position === 0),
			button(`${prefix}:skip`, 'Skip').setDisabled(question.required)
		),
		buttons(
			button(`${prefix}:pause`, 'Pause'),
			button(`${prefix}:cancel`, 'Cancel', ButtonStyle.Danger)
		)
	);
	return panel(
		`## ${safe(session.snapshot.name)}\n-# Question ${session.position + 1} of ${session.snapshot.questions.length}\n\n### ${safe(question.prompt)}\n${hint}\n\n-# Progress is saved for seven days. Submitted answers and files are retained for ${session.snapshot.retentionDays} days for staff review.\n-# zf-prompt:${session.id}:${session.version}`,
		rows
	);
}

export function managePanel(form: FormRecord, actorId: string) {
	const controlId = (action: string) => `zf:m:${form.id}:${actorId}:${action}`;
	const questionCount = form.data.questions.length;
	const status = form.archived ? 'Archived' : form.published ? 'Published' : 'Draft';
	const questions =
		form.data.questions
			.map(
				(question, questionIndex) =>
					`${questionIndex + 1}. ${safe(question.prompt.slice(0, 40))}${question.prompt.length > 40 ? '…' : ''} · \`${question.type}\``
			)
			.join('\n') || '*No questions yet. Add your first question below.*';
	const description = form.data.description ? `\n${safe(form.data.description)}\n` : '';

	return panel(
		`## ${safe(form.data.name)}\n-# ${status} · Revision ${form.data.revision} · ${questionCount} ${questionCount === 1 ? 'question' : 'questions'}\n${description}\n### Questions\n${questions}\n\n-# Changes stay in the draft until you publish.\n-# Form ID: \`${form.id}\``,
		[
			buttons(
				button(controlId('add'), 'Add question', ButtonStyle.Primary),
				button(controlId('edit'), 'Edit').setDisabled(questionCount === 0),
				button(controlId('remove'), 'Remove').setDisabled(questionCount === 0)
			),
			buttons(
				button(controlId('order'), 'Reorder').setDisabled(questionCount < 2),
				button(controlId('details'), 'Details'),
				button(controlId('preview'), 'Preview')
			),
			buttons(
				button(controlId('access'), 'Access'),
				button(controlId('policy'), 'Limits'),
				button(controlId('review'), 'Review channel')
			),
			buttons(
				button(`zf:b:forms:${actorId}:0`, 'All forms'),
				button(controlId('publish'), 'Publish', ButtonStyle.Success),
				button(controlId('archive'), 'Archive', ButtonStyle.Danger)
			)
		]
	);
}

export function explainFormError(error: unknown) {
	if (error instanceof FormError) {
		return error.message;
	}

	if (error instanceof ZodError) {
		return error.issues
			.map((issue) => `${issue.path.join('.') || 'Configuration'}: ${issue.message}`)
			.slice(0, 3)
			.join('\n');
	}

	console.error(
		'A form operation failed. Applicant answers and credentials have not been logged.'
	);
	return 'This could not be completed right now. Your saved progress is safe. Please retry.';
}
