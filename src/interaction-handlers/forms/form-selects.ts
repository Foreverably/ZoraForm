import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { AnySelectMenuInteraction } from 'discord.js';
import { routeFormInteraction } from '../../modules/forms/discord/interaction-router';

export class FormSelectHandler extends InteractionHandler {
	public constructor(
		context: InteractionHandler.LoaderContext,
		options: InteractionHandler.Options
	) {
		super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.SelectMenu });
	}

	public override parse(interaction: AnySelectMenuInteraction) {
		return interaction.customId.startsWith('zf:') ? this.some() : this.none();
	}

	public async run(interaction: AnySelectMenuInteraction) {
		await routeFormInteraction(interaction);
	}
}
