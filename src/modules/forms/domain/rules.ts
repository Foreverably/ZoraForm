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
			throw new FormError(`Use ${question.min}–${question.max} characters.`);
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
		throw new FormError('Enter a number using a dot for decimals.');
	}
	const value = Number(text);
	if (
		!Number.isFinite(value) ||
		value < question.min ||
		value > question.max ||
		(question.integer && !Number.isInteger(value))
	) {
		throw new FormError(
			`Enter ${question.integer ? 'an integer' : 'a number'} between ${question.min} and ${question.max}.`
		);
	}
	return value;
}
