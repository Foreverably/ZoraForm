import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';

@ApplyOptions<Listener.Options>({ once: true, event: Events.ClientReady })
export class ReadyListener extends Listener {
	public override run() {
		this.container.logger.info(`ZoraForms is ready as ${this.container.client.user?.tag}.`);
	}
}
