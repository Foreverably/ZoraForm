import type { FormRecord, FormQuestion, AttachmentReference, QuestionAnswer } from './types';

export class FormError extends Error {}

export function assertFormAccess(
	form: FormRecord,
	userId: string,
	roles: readonly string[] | null
) {
	const rules = form.published;
	if (
		form.archived ||
		!rules ||
		roles === null ||
		rules.blacklist.includes(userId) ||
		rules.denyRoles.some((roleId) => roles.includes(roleId)) ||
		!rules.requiredRoles.every((roleId) => roles.includes(roleId)) ||
		(rules.allowRoles.length > 0 && !rules.allowRoles.some((roleId) => roles.includes(roleId)))
	) {
		throw new FormError('This form is not available to you.');
	}
}

type NumberQuestion = Extract<FormQuestion, { type: 'number' }>;
type TextQuestion = Extract<FormQuestion, { type: 'text' }>;

// Number questions saved before limits became optional stored these values for "no limit".
const legacyNoLimit = 1e9;

export function numberLimits(question: NumberQuestion) {
	return {
		min: question.min === -legacyNoLimit ? null : question.min,
		max: question.max === legacyNoLimit ? null : question.max
	};
}

export function describeNumberLimits(question: NumberQuestion) {
	const { min, max } = numberLimits(question);

	if (min !== null && max !== null) {
		return `between ${min} and ${max}`;
	}

	if (min !== null) {
		return `of at least ${min}`;
	}

	return max === null ? null : `of at most ${max}`;
}

export function describeTextLimits(question: TextQuestion) {
	return question.min > 1
		? `${question.min}–${question.max} characters`
		: `up to ${question.max} characters`;
}

export function validateQuestionAnswer(
	question: FormQuestion,
	answerText: string,
	attachments: AttachmentReference[] = []
): QuestionAnswer {
	if (question.type === 'attachment') {
		if (!attachments.length || attachments.length > 3) {
			throw new FormError(
				'Attach between one and three attachments (8 MiB each; 20 MiB total).'
			);
		}
		return attachments;
	}
	if (attachments.length) {
		throw new FormError('Reply using the requested answer type.');
	}
	const text = answerText.trim();
	if (question.type === 'text') {
		if (text.length < question.min || text.length > question.max) {
			throw new FormError(`Use ${describeTextLimits(question)}.`);
		}
		return text;
	}
	if (question.type === 'choice') {
		if (!question.options.includes(text)) {
			throw new FormError('Choose an option using the current select menu.');
		}
		return text;
	}
	if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
		throw new FormError('Enter a number, such as 25 or 2.5.');
	}
	const value = Number(text);
	const { min, max } = numberLimits(question);
	if (!Number.isFinite(value) || (min !== null && value < min) || (max !== null && value > max)) {
		const limits = describeNumberLimits(question);
		throw new FormError(`Enter a number${limits ? ` ${limits}` : ''}.`);
	}
	return value;
}
