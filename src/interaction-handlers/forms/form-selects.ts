import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { StringSelectMenuInteraction } from 'discord.js';
import { routeFormInteraction } from '../../modules/forms/interaction-router';

export class FormSelectHandler extends InteractionHandler {
	public constructor(
		context: InteractionHandler.LoaderContext,
		options: InteractionHandler.Options
	) {
		super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.SelectMenu });
	}

	public override parse(interaction: StringSelectMenuInteraction) {
		return interaction.customId.startsWith('zf:') ? this.some() : this.none();
	}

	public async run(interaction: StringSelectMenuInteraction) {
		await routeFormInteraction(interaction);
	}
}
