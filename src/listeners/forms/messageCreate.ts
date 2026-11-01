import { RateLimitError } from '../../modules/forms/services/rate-limits';
import { Listener, Events } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { formsRuntime } from '../../modules/forms/runtime';
import { errorPanel } from '../../modules/forms/discord/components';

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
			const runtime = formsRuntime();
			await runtime.rateLimits.enforce(message.author.id, 'message');
			void message.channel.sendTyping().catch(() => undefined);
			await runtime.applicants.handleMessage(message);
			void runtime.delivery.wake();
		} catch (error) {
			if (error instanceof RateLimitError && !error.shouldNotify) {
				return;
			}
			await message.channel.send(errorPanel(error)).catch(() => {
				this.container.logger.warn(
					'Could not send a questionnaire response. Saved progress is unaffected.'
				);
			});
		}
	}
}
