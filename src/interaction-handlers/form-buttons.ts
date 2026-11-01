import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { routeFormInteraction } from '../modules/forms/interaction-router';

export class FormButtonHandler extends InteractionHandler {
	public constructor(
		context: InteractionHandler.LoaderContext,
		options: InteractionHandler.Options
	) {
		super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
	}

	public override parse(interaction: ButtonInteraction) {
		return interaction.customId.startsWith('zf:') ? this.some() : this.none();
	}

	public async run(interaction: ButtonInteraction) {
		await routeFormInteraction(interaction);
	}
}
