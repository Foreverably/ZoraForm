import type * as validation from 'zod';
import type {
	formQuestionSchema,
	formConfigurationSchema,
	questionReferenceSchema
} from './schemas';

export type QuestionReference = validation.infer<typeof questionReferenceSchema>;

export type FormQuestion = validation.infer<typeof formQuestionSchema>;

export type FormConfiguration = validation.infer<typeof formConfigurationSchema>;

export interface FormRecord {
	id: string;
	guildId: string;
	data: FormConfiguration;
	published: FormConfiguration | null;
	archived: boolean;
}

export interface AttachmentReference {
	key: string;
	name: string;
	size: number;
}

export type QuestionAnswer = string | number | AttachmentReference[] | null;

export interface QuestionnaireSession {
	id: string;
	userId: string;
	formId: string;
	guildId: string;
	snapshot: FormConfiguration;
	answers: QuestionAnswer[];
	position: number;
	reviewPage: number | null;
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
