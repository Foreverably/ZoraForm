import * as validation from 'zod';

export const discordSnowflakeSchema = validation.string().regex(/^\d{17,20}$/);
const sharedQuestionFields = {
	id: validation.string().uuid(),
	prompt: validation.string().trim().min(1).max(300),
	required: validation.boolean().default(true)
};

export const formQuestionSchema = validation
	.discriminatedUnion('type', [
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('text'),
			min: validation.number().int().min(0).max(2000).default(1),
			max: validation.number().int().min(1).max(2000).default(2000)
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('number'),
			min: validation.number().finite().default(-1e9),
			max: validation.number().finite().default(1e9),
			integer: validation.boolean().default(false)
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('choice'),
			options: validation.array(validation.string().trim().min(1).max(100)).min(2).max(25)
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('attachment')
		})
	])
	.superRefine((question, validationContext) => {
		if (
			(question.type === 'text' || question.type === 'number') &&
			question.min > question.max
		) {
			validationContext.addIssue({
				code: 'custom',
				message: 'Minimum must not exceed maximum.'
			});
		}
		if (
			question.type === 'choice' &&
			new Set(question.options).size !== question.options.length
		) {
			validationContext.addIssue({
				code: 'custom',
				message: 'Choices must be unique.'
			});
		}
	});

export const formConfigurationSchema = validation.object({
	name: validation.string().trim().min(1).max(80),
	description: validation.string().max(500).default(''),
	reviewChannelId: discordSnowflakeSchema,
	reviewerIds: validation.array(discordSnowflakeSchema).min(1).max(20),
	allowRoles: validation.array(discordSnowflakeSchema).default([]),
	denyRoles: validation.array(discordSnowflakeSchema).default([]),
	requiredRoles: validation.array(discordSnowflakeSchema).default([]),
	blacklist: validation.array(discordSnowflakeSchema).default([]),
	totalLimit: validation.number().int().min(0).max(100000).default(0),
	pendingLimit: validation.number().int().min(0).max(1000).default(1),
	cooldownSeconds: validation.number().int().min(0).max(31536000).default(0),
	retentionDays: validation.number().int().min(1).max(365).default(30),
	questions: validation.array(formQuestionSchema).max(25).default([]),
	revision: validation.number().int().min(1).default(1)
});

export type FormQuestion = validation.infer<typeof formQuestionSchema>;

export type FormConfiguration = validation.infer<typeof formConfigurationSchema>;

export interface FormRecord {
	id: string;
	guildId: string;
	data: FormConfiguration;
	published: FormConfiguration | null;
	archived: boolean;
}

export interface StoredAttachment {
	key: string;
	name: string;
	size: number;
}

export type QuestionAnswer = string | number | StoredAttachment[] | null;

export interface QuestionnaireSession {
	id: string;
	userId: string;
	formId: string;
	guildId: string;
	snapshot: FormConfiguration;
	answers: QuestionAnswer[];
	position: number;
	status: 'prompt' | 'answer' | 'confirm' | 'paused' | 'cancelled' | 'expired' | 'submitted';
	version: number;
	promptId: string | null;
	expiresAt: Date;
}

export interface FormSubmission {
	id: string;
	sessionId: string;
	userId: string;
	formId: string;
	guildId: string;
	snapshot: FormConfiguration;
	answers: QuestionAnswer[];
	status: 'pending' | 'accepted' | 'rejected';
	threadId: string | null;
	reviewerId: string | null;
	reason: string | null;
	archived: boolean;
	createdAt: Date;
}

export interface DeliveryJob {
	id: string;
	kind: 'prompt' | 'review' | 'receipt' | 'close';
	payload: {
		id: string;
		version?: number;
	};
	attempts: number;
}

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
	attachments: StoredAttachment[] = []
): QuestionAnswer {
	if (question.type === 'attachment') {
		if (!attachments.length || attachments.length > 3) {
			throw new FormError(
				'Attach between one and three PNG, JPEG, PDF or text attachments (8 MiB each; 20 MiB total).'
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
