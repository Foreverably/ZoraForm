import { Listener, Events } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { formsRuntime } from '../../modules/forms/runtime';
import { explainFormError } from '../../modules/forms/discord/components';

export class DirectMessageListener extends Listener<typeof Events.MessageCreate> {
	public override async run(message: Message) {
		if (
			message.author.bot ||
			message.system ||
			message.inGuild() ||
			!message.channel.isSendable()
		) {
			return;
		}

		try {
			await formsRuntime().applicants.handleMessage(message);
		} catch (error) {
			await message.channel.send(explainFormError(error)).catch(() => {
				this.container.logger.warn(
					'Could not send a questionnaire response. Saved progress is unaffected.'
				);
			});
		}
	}
}
