import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ChannelType, InteractionContextType, MessageFlags } from 'discord.js';
import { getBotName } from '../../lib/environment';
import { formsRuntime } from '../../modules/forms/runtime';
import { explainFormError, managePanel } from '../../modules/forms/discord/components';
import { FormError } from '../../modules/forms/domain/rules';

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
						.setName('submissions')
						.setDescription('Browse submissions from channels you can read')
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('permissions')
						.setDescription('Choose which roles and users can do staff actions')
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

			if (action === 'permissions') {
				await interaction.editReply(await runtime.staffPanel.overview(guild.id, identity));
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

			await interaction.editReply(
				await runtime.browsing.submissionForms(guild, identity.userId)
			);
		} catch (error) {
			await interaction.editReply(explainFormError(error));
		}
	}
}
