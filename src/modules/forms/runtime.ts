import { FormBrowsing } from './discord/browsing';
import type { Client } from 'discord.js';
import { createPostgresConnection } from '../../database/database';
import { FormService } from './services/form-service';
import { AttachmentTransfer } from './services/attachment-transfer';
import { StaffPermissions } from './services/staff-permissions';
import { RateLimits } from './services/rate-limits';
import { DiscordDelivery } from './discord/delivery-worker';
import { ApplicantFlow } from './discord/applicant-flow';
import { FormBuilder } from './discord/form-builder';
import { SubmissionRecovery } from './discord/submission-recovery';
import { StaffPermissionsPanel } from './discord/staff-permissions-panel';
import { FormError } from './domain/rules';

let activeRuntime: ReturnType<typeof createRuntime> | undefined;

export function createRuntime(client: Client, connectionString: string) {
	const connection = createPostgresConnection(connectionString);
	const formService = new FormService(connection.database);
	const attachments = new AttachmentTransfer(connection.database, client);
	const permissions = new StaffPermissions(connection.database);
	const rateLimits = new RateLimits(connection.database);
	const delivery = new DiscordDelivery(client, formService, attachments);
	const applicants = new ApplicantFlow(client, formService, attachments);
	const browsing = new FormBrowsing(formService, permissions, client);
	const builder = new FormBuilder(formService, delivery, permissions, browsing);
	const recovery = new SubmissionRecovery(formService, delivery, permissions, browsing);
	const staffPanel = new StaffPermissionsPanel(formService, permissions);
	const runtime = {
		connection,
		formService,
		attachments,
		permissions,
		rateLimits,
		browsing,
		delivery,
		applicants,
		builder,
		recovery,
		staffPanel
	};
	activeRuntime = runtime;
	return runtime;
}

export function formsRuntime() {
	if (!activeRuntime) {
		throw new FormError('The forms service is starting. Please retry shortly.');
	}

	return activeRuntime;
}
