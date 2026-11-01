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
