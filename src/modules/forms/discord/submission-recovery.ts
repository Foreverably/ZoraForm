import {
	ButtonStyle,
	type AnySelectMenuInteraction,
	type ButtonInteraction,
	type Guild
} from 'discord.js';
import { FormError } from '../domain/rules';
import { FormService } from '../services/form-service';
import { StaffPermissions } from '../services/staff-permissions';
import { FormBrowsing } from './browsing';
import { button, buttons, panel } from './components';
import { DiscordDelivery, MissingReviewThreadError } from './delivery-worker';

export class SubmissionRecovery {
	public constructor(
		private readonly formService: FormService,
		private readonly delivery: DiscordDelivery,
		private readonly permissions: StaffPermissions,
		private readonly browsing: FormBrowsing
	) {}

	public async handle(
		interaction: ButtonInteraction | AnySelectMenuInteraction,
		guild: Guild,
		actorId: string,
		segments: string[]
	) {
		const identity = await this.permissions.identify(guild, actorId);
		await this.permissions.assertAllowed(guild.id, 'submissions.repair', identity);

		const allowReplacement = segments[2] === 'recreate';
		const submissionId = allowReplacement
			? segments[3]
			: interaction.isStringSelectMenu()
				? interaction.values[0]
				: undefined;

		if (!submissionId) {
			throw new FormError('Choose a submission to recover.');
		}

		const submission = await this.formService.findSubmission(submissionId);
		const form = await this.formService.findForm(submission.formId);
		await this.browsing.assertChannelReader(form, guild, actorId);
		const page = allowReplacement ? 0 : Number(segments[5]);

		try {
			await this.delivery.repairReview(submission.id, guild.id, actorId, allowReplacement);
		} catch (error) {
			if (!(error instanceof FormError)) {
				throw error;
			}

			await interaction.editReply(
				panel(error.message, [
					buttons(
						...(error instanceof MissingReviewThreadError
							? [
									button(
										`zf:b:recreate:${submission.id}:${actorId}`,
										'Create replacement thread',
										ButtonStyle.Danger
									)
								]
							: []),
						button(
							`zf:b:submissions:${form.id}:${actorId}:${page}`,
							'Back to submissions'
						)
					)
				])
			);
			return;
		}

		await interaction.editReply(
			await this.browsing.submissions(
				guild,
				form.id,
				actorId,
				page,
				'Delivery recovery is queued for that submission.'
			)
		);
	}
}
