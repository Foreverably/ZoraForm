import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { and, eq, desc } from 'drizzle-orm';
import { formsRuntime } from '../../modules/forms/runtime';
import { explainFormError } from '../../modules/forms/discord/components';
import { requireFormAdmin } from '../../modules/forms/discord/form-builder';
import { managePanel, panel, safe } from '../../modules/forms/discord/components';
import { submissions } from '../../database/schema';
import { FormError } from '../../modules/forms/domain/rules';

@ApplyOptions<Command.Options>({ description: 'Create and manage ZoraForms questionnaires.' })
export class FormCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((command) =>
			command
				.setName('form')
				.setDescription(this.description)
				.setContexts(InteractionContextType.Guild)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('create')
						.setDescription('Create a new draft form')
						.addStringOption((option) =>
							option
								.setName('name')
								.setDescription('Form name')
								.setRequired(true)
								.setMaxLength(80)
						)
						.addChannelOption((option) =>
							option
								.setName('review-channel')
								.setDescription(
									'Staff-only text channel for private review threads'
								)
								.addChannelTypes(ChannelType.GuildText)
								.setRequired(true)
						)
						.addUserOption((option) =>
							option
								.setName('reviewer')
								.setDescription('Staff member who will review submissions')
								.setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('list').setDescription('List forms in this server')
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('manage')
						.setDescription('Open the form builder')
						.addStringOption((option) =>
							option
								.setName('id')
								.setDescription('Form ID from /form list')
								.setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('archive')
						.setDescription('Archive a form and stop new submissions')
						.addStringOption((option) =>
							option.setName('id').setDescription('Form ID').setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('submissions')
						.setDescription('Inspect recent submission and delivery status')
						.addStringOption((option) =>
							option.setName('id').setDescription('Form ID').setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('blacklist')
						.setDescription('Block or unblock an applicant across this server')
						.addUserOption((option) =>
							option.setName('user').setDescription('Applicant').setRequired(true)
						)
						.addBooleanOption((option) =>
							option
								.setName('blocked')
								.setDescription('True to block, false to unblock')
								.setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('repair')
						.setDescription('Recover a failed private review delivery')
						.addStringOption((option) =>
							option
								.setName('submission')
								.setDescription('Submission ID')
								.setRequired(true)
						)
						.addBooleanOption((option) =>
							option
								.setName('recreate')
								.setDescription(
									'Allow a replacement after checking that the thread is missing'
								)
						)
				)
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const guild = await requireFormAdmin(interaction.guild, interaction.user.id);
			const runtime = formsRuntime();
			const action = interaction.options.getSubcommand();

			if (action === 'create') {
				const reviewChannel = interaction.options.getChannel('review-channel', true);
				const reviewer = interaction.options.getUser('reviewer', true);
				const form = await runtime.formService.createForm(guild.id, interaction.user.id, {
					name: interaction.options.getString('name', true),
					reviewChannelId: reviewChannel.id,
					reviewerIds: [reviewer.id]
				});
				await interaction.editReply(managePanel(form, interaction.user.id));
				return;
			}

			if (action === 'list') {
				const serverForms = await runtime.formService.listForms(guild.id);
				const description = serverForms
					.slice(0, 20)
					.map(
						(form) =>
							`${safe(form.data.name)} · ${form.archived ? 'archived' : form.published ? 'published' : 'draft'}\n${form.id}`
					)
					.join('\n\n');
				await interaction.editReply(
					panel(
						`## Server forms\n${description || 'No forms yet. Use /form create.'}${serverForms.length > 20 ? '\nShowing the first 20 forms.' : ''}`
					)
				);
				return;
			}

			if (action === 'blacklist') {
				await runtime.formService.setGuildBlacklist(
					guild.id,
					interaction.user.id,
					interaction.options.getUser('user', true).id,
					interaction.options.getBoolean('blocked', true)
				);
				await interaction.editReply('Server blacklist updated.');
				return;
			}

			if (action === 'repair') {
				await runtime.delivery.repairReview(
					interaction.options.getString('submission', true),
					guild.id,
					interaction.user.id,
					interaction.options.getBoolean('recreate') ?? false
				);
				await interaction.editReply('The review delivery has been queued for recovery.');
				return;
			}

			const form = await runtime.formService.findForm(
				interaction.options.getString('id', true)
			);

			if (form.guildId !== guild.id) {
				throw new FormError('This form belongs to another server.');
			}

			if (action === 'archive') {
				await runtime.formService.archiveForm(form.id, guild.id, interaction.user.id);
				await interaction.editReply(
					'Form archived. It is no longer available in the DM directory.'
				);
				return;
			}

			if (action === 'submissions') {
				const recentSubmissions = await runtime.formService.database
					.select()
					.from(submissions)
					.where(and(eq(submissions.formId, form.id), eq(submissions.guildId, guild.id)))
					.orderBy(desc(submissions.createdAt))
					.limit(15);
				const statuses = recentSubmissions
					.map(
						(submission) =>
							`${submission.id}\n${submission.status} · review ${submission.deliveryState} · ${submission.archived ? 'archived' : 'open'}`
					)
					.join('\n\n');
				await interaction.editReply(
					panel(
						`## ${safe(form.data.name)} submissions\n${statuses || 'No submissions yet.'}`
					)
				);
				return;
			}

			await interaction.editReply(managePanel(form, interaction.user.id));
		} catch (error) {
			await interaction.editReply(explainFormError(error));
		}
	}
}
