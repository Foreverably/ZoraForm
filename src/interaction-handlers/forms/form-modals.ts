import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ModalSubmitInteraction } from 'discord.js';
import { routeFormInteraction } from '../../modules/forms/interaction-router';

export class FormModalHandler extends InteractionHandler {
	public constructor(
		context: InteractionHandler.LoaderContext,
		options: InteractionHandler.Options
	) {
		super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
	}

	public override parse(interaction: ModalSubmitInteraction) {
		return interaction.customId.startsWith('zf:') ? this.some() : this.none();
	}

	public async run(interaction: ModalSubmitInteraction) {
		await routeFormInteraction(interaction);
	}
}
