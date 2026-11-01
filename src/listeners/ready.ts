import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import { formsRuntime } from '../modules/forms/runtime';
@ApplyOptions<Listener.Options>({
	once: true,
	event: Events.ClientReady
})
export class ReadyListener extends Listener {
	public override run() {
		formsRuntime().delivery.start();
		this.container.logger.info(`ZoraForms is ready as ${this.container.client.user?.tag}.`);
	}
}
