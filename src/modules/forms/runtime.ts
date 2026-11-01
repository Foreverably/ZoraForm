import type { Client } from 'discord.js';
import { createPostgresConnection } from '../../database/database';
import { FormService } from './services/form-service';
import { AttachmentStorage } from './services/attachment-storage';
import { DiscordDelivery } from './discord/delivery-worker';
import { ApplicantFlow } from './discord/applicant-flow';
import { FormBuilder } from './discord/form-builder';
import { FormError } from './domain/rules';

let activeRuntime: ReturnType<typeof createRuntime> | undefined;

export function createRuntime(client: Client, connectionString: string) {
	const connection = createPostgresConnection(connectionString);
	const formService = new FormService(connection.database);
	const storage = new AttachmentStorage(
		connection.database,
		process.env.ATTACHMENT_DIRECTORY ?? '.data/attachments'
	);
	const delivery = new DiscordDelivery(client, formService, storage);
	const applicants = new ApplicantFlow(client, formService, storage);
	const builder = new FormBuilder(formService, delivery);
	const runtime = { connection, formService, storage, delivery, applicants, builder };
	activeRuntime = runtime;
	return runtime;
}

export function formsRuntime() {
	if (!activeRuntime) {
		throw new FormError('The forms service is starting. Please retry shortly.');
	}

	return activeRuntime;
}
