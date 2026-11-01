import * as validation from 'zod';

export const discordSnowflakeSchema = validation.string().regex(/^\d{17,20}$/);
export const questionReferenceSchema = validation.object({
	channelId: discordSnowflakeSchema,
	messageId: discordSnowflakeSchema,
	attachmentId: discordSnowflakeSchema,
	name: validation.string().min(1).max(100),
	size: validation
		.number()
		.int()
		.min(1)
		.max(8 * 1024 * 1024),
	image: validation.boolean()
});

const sharedQuestionFields = {
	id: validation.uuid(),
	prompt: validation
		.string()
		.trim()
		.min(1, 'Write the question first.')
		.max(300, 'Questions can be up to 300 characters.'),
	required: validation.boolean().default(true),
	references: validation.array(questionReferenceSchema).max(3).default([])
};

export const formQuestionSchema = validation
	.discriminatedUnion('type', [
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('text'),
			min: validation
				.number('Limits must be whole numbers.')
				.int('Limits must be whole numbers.')
				.min(0, 'The minimum cannot be below 0.')
				.max(2000, 'Answers can be up to 2,000 characters.')
				.default(1),
			max: validation
				.number('Limits must be whole numbers.')
				.int('Limits must be whole numbers.')
				.min(1, 'The maximum must be at least 1.')
				.max(2000, 'Answers can be up to 2,000 characters.')
				.default(2000)
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('number'),
			min: validation.number().nullable().default(null),
			max: validation.number().nullable().default(null)
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('choice'),
			options: validation
				.array(
					validation
						.string()
						.trim()
						.min(1, 'Answer choices cannot be empty.')
						.max(100, 'Answer choices can be up to 100 characters.')
				)
				.min(2, 'Add at least 2 answer choices.')
				.max(25, 'Questions can have up to 25 answer choices.')
		}),
		validation.object({
			...sharedQuestionFields,
			type: validation.literal('attachment')
		})
	])
	.superRefine((question, validationContext) => {
		if (
			(question.type === 'text' || question.type === 'number') &&
			question.min !== null &&
			question.max !== null &&
			question.min > question.max
		) {
			validationContext.addIssue({
				code: 'custom',
				message: 'The minimum cannot be higher than the maximum.'
			});
		}
		if (
			question.type === 'choice' &&
			new Set(question.options).size !== question.options.length
		) {
			validationContext.addIssue({
				code: 'custom',
				message: 'Each answer choice must be different.'
			});
		}
	});

export const formConfigurationSchema = validation.object({
	name: validation
		.string()
		.trim()
		.min(1, 'Give the form a name.')
		.max(80, 'Form names can be up to 80 characters.'),
	description: validation
		.string()
		.max(500, 'Descriptions can be up to 500 characters.')
		.default(''),
	reviewChannelId: discordSnowflakeSchema,
	allowRoles: validation.array(discordSnowflakeSchema).default([]),
	denyRoles: validation.array(discordSnowflakeSchema).default([]),
	requiredRoles: validation.array(discordSnowflakeSchema).default([]),
	blacklist: validation.array(discordSnowflakeSchema).default([]),
	totalLimit: validation.number().int().min(0).max(100000).default(0),
	pendingLimit: validation.number().int().min(0).max(1000).default(1),
	cooldownSeconds: validation.number().int().min(0).max(31536000).default(0),
	questions: validation
		.array(formQuestionSchema)
		.max(25, 'Forms can have up to 25 questions.')
		.default([]),
	revision: validation.number().int().min(1).default(1)
});
