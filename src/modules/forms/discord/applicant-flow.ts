import { getBotName } from '../../../lib/environment';
import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	ButtonStyle,
	type Client,
	type Message,
	type ButtonInteraction,
	type StringSelectMenuInteraction
} from 'discord.js';
import { FormService } from '../services/form-service';
import { AttachmentTransfer } from '../services/attachment-transfer';
import { FormError } from '../domain/rules';
import type { QuestionnaireSession } from '../domain/types';
import { panel, buttons, button, safe, summary } from './components';

export class ApplicantFlow {
	public constructor(
		private readonly client: Client,
		private readonly formService: FormService,
		private readonly attachments: AttachmentTransfer
	) {}

	public async memberRoles(guildId: string, userId: string) {
		const guild = this.client.guilds.cache.get(guildId);

		if (!guild) {
			return null;
		}

		try {
			const member = await guild.members.fetch({ user: userId, force: true });
			return [...member.roles.cache.keys()];
		} catch (error) {
			if (typeof error === 'object' && error && 'code' in error && error.code === 10007) {
				return null;
			}

			throw new FormError(
				'Membership could not be checked right now. Your progress is safe; please retry.'
			);
		}
	}

	public async directory(userId: string, requestedPage = 0) {
		const availableForms = [];
		const guildRoles = new Map<string, Awaited<ReturnType<ApplicantFlow['memberRoles']>>>();

		for (const form of await this.formService.listForms()) {
			if (!form.published) {
				continue;
			}

			if (!guildRoles.has(form.guildId)) {
				guildRoles.set(form.guildId, await this.memberRoles(form.guildId, userId));
			}

			try {
				await this.formService.assertEligibility(
					form,
					userId,
					guildRoles.get(form.guildId) ?? null
				);
				availableForms.push(form);
			} catch (error) {
				if (!(error instanceof FormError)) {
					throw error;
				}
			}
		}

		const pageCount = Math.max(1, Math.ceil(availableForms.length / 25));
		const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
		const pageForms = availableForms.slice(page * 25, page * 25 + 25);
		const controls = [];

		if (pageForms.length) {
			controls.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId('zf:directory:select')
						.setPlaceholder('Choose a form')
						.addOptions(
							pageForms.map((form) => ({
								label: form.published!.name,
								description: (
									this.client.guilds.cache.get(form.guildId)?.name ?? 'Community'
								).slice(0, 100),
								value: form.id
							}))
						)
				)
			);
		}

		controls.push(
			buttons(
				button(`zf:directory:page:${page - 1}`, 'Previous').setDisabled(page === 0),
				button(`zf:directory:page:${page + 1}`, 'Next').setDisabled(page === pageCount - 1),
				button(`zf:directory:page:${page}`, 'Refresh'),
				button('zf:directory:status', 'My submissions')
			)
		);

		return panel(
			`## ${safe(getBotName())}\n${pageForms.length ? 'Choose a form to begin. Each answer is saved automatically.' : 'There are no forms available to you right now. Try Refresh later.'}\nPage ${page + 1} of ${pageCount}`,
			controls
		);
	}

	private resumePanel(session: QuestionnaireSession) {
		const prefix = `zf:s:${session.id}:${session.version}`;

		return panel(
			`## ${safe(session.snapshot.name)}\nYour saved questionnaire is ${session.status === 'paused' ? 'paused' : 'in progress'}. Resume to see the current question, or cancel to choose a different form.`,
			[
				buttons(
					button(`${prefix}:resume`, 'Resume', ButtonStyle.Primary),
					button(`${prefix}:cancel`, 'Cancel', ButtonStyle.Danger)
				)
			]
		);
	}

	public async handleMessage(message: Message) {
		if (!message.channel.isSendable()) {
			return;
		}

		const session = await this.formService.findActiveSession(message.author.id);

		if (!session) {
			await message.channel.send(await this.directory(message.author.id));
			return;
		}

		if (session.status !== 'answer') {
			await message.channel.send(this.resumePanel(session));
			return;
		}

		const question = session.snapshot.questions[session.position];

		if (!question) {
			throw new FormError('Resume your questionnaire to continue.');
		}

		if (question.type === 'choice') {
			throw new FormError('Choose an answer from the select menu on the latest question.');
		}

		const memberRoleIds = await this.memberRoles(session.guildId, message.author.id);
		const currentForm = await this.formService.findForm(session.formId);
		await this.formService.assertEligibility(currentForm, message.author.id, memberRoleIds);

		if (question.type !== 'attachment' && message.attachments.size) {
			throw new FormError('This question expects a written answer.');
		}

		const attachments =
			question.type === 'attachment'
				? await this.attachments.capture(session.id, message)
				: [];

		try {
			const answerSaved = await this.formService.saveAnswer(
				session.id,
				message.author.id,
				session.version,
				memberRoleIds,
				message.id,
				message.content,
				attachments,
				message.reference?.messageId ?? undefined
			);

			if (!answerSaved) {
				await this.attachments.remove(attachments);
			}
		} catch (error) {
			await this.attachments.remove(attachments);
			throw error;
		}
	}

	public async handleInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
		if (interaction.inGuild()) {
			throw new FormError(`Use the questionnaire controls in your DMs with ${getBotName()}.`);
		}

		const segments = interaction.customId.split(':');
		await interaction.deferUpdate();

		if (segments[1] === 'directory') {
			if (segments[2] === 'select' && interaction.isStringSelectMenu()) {
				const formId = interaction.values[0];

				if (!formId) {
					throw new FormError('Choose a form.');
				}

				const form = await this.formService.findForm(formId);
				await this.formService.startSession(
					formId,
					interaction.user.id,
					await this.memberRoles(form.guildId, interaction.user.id)
				);
				await interaction.editReply(
					panel('Your questionnaire is starting. The first question will arrive in a DM.')
				);
				return;
			}

			await interaction.editReply(
				await this.directory(interaction.user.id, Number(segments[3] ?? 0))
			);
			return;
		}

		const sessionId = segments[2]!;
		const version = Number(segments[3]);
		const action = segments[4];
		const session = await this.formService.findSession(sessionId);

		if (session.userId !== interaction.user.id || session.version !== version) {
			throw new FormError(
				'This control is out of date. Use the latest question or DM the bot to resume.'
			);
		}

		if (action === 'cancel') {
			await interaction.editReply(
				panel('Cancel this questionnaire? Your progress will be discarded.', [
					buttons(
						button(
							`zf:s:${session.id}:${version}:cancel-confirm`,
							'Yes, cancel',
							ButtonStyle.Danger
						),
						button(`zf:s:${session.id}:${version}:resume`, 'Keep answering')
					)
				])
			);
			return;
		}

		const roles =
			action === 'cancel-confirm'
				? null
				: await this.memberRoles(session.guildId, interaction.user.id);

		if (action === 'summary') {
			if (session.status !== 'confirm') {
				throw new FormError('Finish your answers before reviewing them.');
			}
			await this.formService.assertEligibility(
				await this.formService.findForm(session.formId),
				interaction.user.id,
				roles
			);
			await interaction.editReply(
				summary(session, Number(segments[5] ?? 0), Number(segments[6] ?? 0))
			);
			return;
		}

		if (action === 'submit') {
			for (const answer of session.answers) {
				if (Array.isArray(answer)) {
					for (const attachment of answer) {
						await this.attachments.assertAvailable(attachment);
					}
				}
			}

			const submission = await this.formService.submitSession(
				session.id,
				interaction.user.id,
				version,
				roles
			);
			await interaction.editReply(
				panel(
					`Submitted successfully. Your staff review is being prepared.\nSubmission ID: ${submission.id}`
				)
			);
			return;
		}

		if (action === 'choice' && interaction.isStringSelectMenu()) {
			const question = session.snapshot.questions[session.position];
			const choiceIndex = Number(interaction.values[0]);

			if (
				question?.type !== 'choice' ||
				!Number.isInteger(choiceIndex) ||
				!question.options[choiceIndex]
			) {
				throw new FormError('Choose one of the listed answers.');
			}

			await this.formService.saveAnswer(
				session.id,
				interaction.user.id,
				version,
				roles,
				interaction.id,
				question.options[choiceIndex]!
			);
			await interaction.editReply(panel('Answer saved. The next step will arrive shortly.'));
			return;
		}

		if (action === 'edit') {
			await this.formService.editAnswerPosition(
				session.id,
				interaction.user.id,
				version,
				roles,
				Number(segments[5])
			);
			await interaction.editReply(panel('Opening that question for editing.'));
			return;
		}

		const navigation = action === 'cancel-confirm' ? 'cancel' : action;

		if (
			navigation !== 'resume' &&
			navigation !== 'back' &&
			navigation !== 'skip' &&
			navigation !== 'pause' &&
			navigation !== 'cancel'
		) {
			throw new FormError('Unknown questionnaire action.');
		}

		await this.formService.navigateSession(
			session.id,
			interaction.user.id,
			version,
			roles,
			navigation
		);
		await interaction.editReply(
			navigation === 'cancel'
				? await this.directory(interaction.user.id)
				: navigation === 'pause'
					? panel('Questionnaire paused. DM the bot when you are ready to resume.')
					: panel('Your saved question will arrive shortly.')
		);
	}
}
