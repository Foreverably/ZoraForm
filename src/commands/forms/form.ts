import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ChannelType, InteractionContextType, MessageFlags } from 'discord.js';
import { getBotName } from '../../lib/environment';
import { formsRuntime } from '../../modules/forms/runtime';
import { explainFormError, managePanel } from '../../modules/forms/discord/components';
import { FormError } from '../../modules/forms/domain/rules';
import { staffCapabilities, type StaffCapability } from '../../modules/forms/domain/permissions';

@ApplyOptions<Command.Options>({ description: `Create and manage ${getBotName()} questionnaires.` })
export class FormCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((command) =>
			command
				.setName('form')
				.setDescription(this.description)
				.setContexts(InteractionContextType.Guild)
				.setDefaultMemberPermissions(null)
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
									'Submission channel; Discord controls who can read it'
								)
								.addChannelTypes(ChannelType.GuildText)
								.setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('list').setDescription('Browse forms in this server')
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
						.setDescription('Browse submissions from a channel you can read')
						.addStringOption((option) =>
							option.setName('id').setDescription('Form ID').setRequired(true)
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('blacklist')
						.setDescription('Block or unblock a user or role')
						.addBooleanOption((option) =>
							option
								.setName('blocked')
								.setDescription('True to block, false to unblock')
								.setRequired(true)
						)
						.addUserOption((option) =>
							option
								.setName('user')
								.setDescription('User to block; choose either a user or a role')
						)
						.addRoleOption((option) =>
							option
								.setName('role')
								.setDescription('Role to block; choose either a user or a role')
						)
						.addStringOption((option) =>
							option
								.setName('form')
								.setDescription('Optional form ID; omit to apply server-wide')
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('permission')
						.setDescription('Grant or revoke a specific staff action')
						.addStringOption((option) =>
							option
								.setName('action')
								.setDescription('Staff capability')
								.setRequired(true)
								.addChoices(
									...staffCapabilities.map((capability) => ({
										name: capability,
										value: capability
									}))
								)
						)
						.addBooleanOption((option) =>
							option
								.setName('allowed')
								.setDescription('True to grant, false to revoke')
								.setRequired(true)
						)
						.addUserOption((option) =>
							option.setName('user').setDescription('User receiving the grant')
						)
						.addRoleOption((option) =>
							option.setName('role').setDescription('Role receiving the grant')
						)
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('repair')
						.setDescription('Recover a failed submission delivery')
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
									'Allow a replacement after checking the thread is missing'
								)
						)
				)
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const runtime = formsRuntime();
			await runtime.rateLimits.enforce(interaction.user.id, 'command');
			const guild = interaction.guild;

			if (!guild) {
				throw new FormError('Manage forms from a server.');
			}

			const identity = await runtime.permissions.identify(guild, interaction.user.id);
			const action = interaction.options.getSubcommand();

			if (action === 'permission' || action === 'blacklist') {
				const user = interaction.options.getUser('user');
				const role = interaction.options.getRole('role');

				if (Boolean(user) === Boolean(role)) {
					throw new FormError('Choose exactly one user or one role.');
				}

				const subjectId = user?.id ?? role!.id;
				const subjectType = user ? 'user' : 'role';

				if (action === 'permission') {
					const capability = interaction.options.getString(
						'action',
						true
					) as StaffCapability;

					if (!staffCapabilities.includes(capability)) {
						throw new FormError('Choose a supported staff action.');
					}

					await runtime.permissions.configure(
						guild.id,
						identity,
						capability,
						subjectType,
						subjectId,
						interaction.options.getBoolean('allowed', true)
					);
					await runtime.formService.recordAuditEvent(
						runtime.formService.database,
						guild.id,
						identity.userId,
						'staff.permission.configure',
						`${capability}:${subjectType}:${subjectId}`
					);
					await interaction.editReply(
						'Staff permission updated. Channel visibility remains controlled by Discord.'
					);
					return;
				}

				await runtime.permissions.assertAllowed(guild.id, 'forms.blacklist', identity);
				const formId = interaction.options.getString('form');
				const blocked = interaction.options.getBoolean('blocked', true);

				if (formId) {
					await runtime.formService.setFormBlacklist(
						formId,
						guild.id,
						identity.userId,
						subjectType,
						subjectId,
						blocked
					);
				} else if (role) {
					await runtime.formService.setRoleBlacklist(
						guild.id,
						identity.userId,
						role.id,
						blocked
					);
				} else {
					await runtime.formService.setGuildBlacklist(
						guild.id,
						identity.userId,
						user!.id,
						blocked
					);
				}

				await interaction.editReply(`${formId ? 'Form' : 'Server'} blacklist updated.`);
				return;
			}

			if (action === 'create') {
				await runtime.permissions.assertAllowed(guild.id, 'forms.create', identity);
				const form = await runtime.formService.createForm(guild.id, identity.userId, {
					name: interaction.options.getString('name', true),
					reviewChannelId: interaction.options.getChannel('review-channel', true).id
				});
				await interaction.editReply(managePanel(form, identity.userId));
				return;
			}

			if (action === 'list') {
				await interaction.editReply(await runtime.browsing.forms(guild, identity.userId));
				return;
			}

			if (action === 'repair') {
				await runtime.permissions.assertAllowed(guild.id, 'submissions.repair', identity);
				await runtime.delivery.repairReview(
					interaction.options.getString('submission', true),
					guild.id,
					identity.userId,
					interaction.options.getBoolean('recreate') ?? false
				);
				await interaction.editReply('Submission delivery has been queued for recovery.');
				return;
			}

			const form = await runtime.formService.findForm(
				interaction.options.getString('id', true)
			);

			if (form.guildId !== guild.id) {
				throw new FormError('This form belongs to another server.');
			}

			if (action === 'archive') {
				await runtime.permissions.assertAllowed(guild.id, 'forms.archive', identity);
				await runtime.formService.archiveForm(form.id, guild.id, identity.userId);
				await interaction.editReply(
					'Form archived. It is no longer available in the DM directory.'
				);
				return;
			}

			if (action === 'submissions') {
				await interaction.editReply(
					await runtime.browsing.submissions(guild, form.id, identity.userId)
				);
				return;
			}

			await runtime.browsing.assertManagement(guild, identity.userId);
			await interaction.editReply(managePanel(form, identity.userId));
		} catch (error) {
			await interaction.editReply(explainFormError(error));
		}
	}
}
