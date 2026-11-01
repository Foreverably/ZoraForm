import type { Client } from 'discord.js';
import { ZodError } from 'zod';
import { createPostgresConnection } from '../../database/database';
import { FormEngine } from './engine';
import { AttachmentStorage } from './storage';
import { DiscordDelivery } from './delivery';
import { ApplicantFlow } from './applicant-flow';
import { FormBuilder } from './builder';
import { FormError } from './model';

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

let activeRuntime: ReturnType<typeof createRuntime> | undefined;

export function createRuntime(client: Client, connectionString: string) {
	const connection = createPostgresConnection(connectionString);
	const engine = new FormEngine(connection.database);
	const storage = new AttachmentStorage(
		connection.database,
		process.env.ATTACHMENT_DIRECTORY ?? '.data/attachments'
	);
	const delivery = new DiscordDelivery(client, engine, storage);
	const applicants = new ApplicantFlow(client, engine, storage);
	const builder = new FormBuilder(engine, delivery);
	const runtime = { connection, engine, storage, delivery, applicants, builder };
	activeRuntime = runtime;
	return runtime;
}

export function formsRuntime() {
	if (!activeRuntime) {
		throw new FormError('The forms service is starting. Please retry shortly.');
	}

	return activeRuntime;
}
