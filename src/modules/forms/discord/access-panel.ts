import {
	ActionRowBuilder,
	RoleSelectMenuBuilder,
	UserSelectMenuBuilder,
	type AnySelectMenuInteraction
} from 'discord.js';
import { FormError } from '../domain/rules';
import type { FormConfiguration, FormRecord } from '../domain/types';
import { button, buttons, panel, safe, type Row } from './components';

const accessCategories = {
	allowRoles: 'Allowed roles (any)',
	requiredRoles: 'Required roles (all)',
	denyRoles: 'Blacklisted roles',
	blacklist: 'Blacklisted users'
} as const;

type AccessCategory = keyof typeof accessCategories;

function accessCategory(value: string): AccessCategory {
	if (!Object.hasOwn(accessCategories, value)) {
		throw new FormError('Choose a supported access setting.');
	}

	return value as AccessCategory;
}

export function accessPanel(form: FormRecord, actorId: string, requestedCategory?: string) {
	const controls: Row[] = [];
	const prefix = `zf:access:${form.id}:${actorId}`;
	let description = 'Choose which access list to change. Blacklists always take priority.';

	if (requestedCategory) {
		const category = accessCategory(requestedCategory);
		const identifiers = form.data[category];
		const noun = category === 'blacklist' ? 'users' : 'roles';
		description = `### ${accessCategories[category]}\n${identifiers.length} ${noun} configured. Select up to 25 at a time to add or remove.\nChanges are saved to the draft until you publish.`;

		for (const operation of ['add', 'remove'] as const) {
			const selector =
				category === 'blacklist'
					? new UserSelectMenuBuilder()
					: new RoleSelectMenuBuilder();
			selector
				.setCustomId(`${prefix}:${category}:${operation}:${form.data.revision}`)
				.setPlaceholder(`${operation === 'add' ? 'Add' : 'Remove'} ${noun}`)
				.setMinValues(1)
				.setMaxValues(25);
			controls.push(
				new ActionRowBuilder<RoleSelectMenuBuilder | UserSelectMenuBuilder>().addComponents(
					selector
				)
			);
		}

		if (identifiers.length) {
			description += `\n\nConfigured ${noun}:\n${identifiers.map((identifier) => (category === 'blacklist' ? `<@${identifier}>` : `<@&${identifier}>`)).join(' ')}`;
		}
	}

	controls.push(
		buttons(
			...Object.entries(accessCategories).map(([category, label]) =>
				button(`${prefix}:${category}:open`, label).setDisabled(
					category === requestedCategory
				)
			)
		)
	);
	controls.push(buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')));

	return panel(`## ${safe(form.data.name)} — Applicant access\n\n${description}`, controls);
}

export function updateAccessList(
	configuration: FormConfiguration,
	interaction: AnySelectMenuInteraction,
	segments: string[]
): FormConfiguration {
	const category = accessCategory(segments[4]!);
	const operation = segments[5];

	if (configuration.revision !== Number(segments[6])) {
		throw new FormError(
			'This access list changed. Reopen Access before making another change.'
		);
	}

	if (
		category === 'blacklist' ? !interaction.isUserSelectMenu() : !interaction.isRoleSelectMenu()
	) {
		throw new FormError('Use the matching user or role selector.');
	}

	if (operation !== 'add' && operation !== 'remove') {
		throw new FormError('Choose whether to add or remove entries.');
	}

	const selectedIdentifiers = new Set(interaction.values);
	const identifiers =
		operation === 'add'
			? [...new Set([...configuration[category], ...selectedIdentifiers])]
			: configuration[category].filter((identifier) => !selectedIdentifiers.has(identifier));

	if (identifiers.length > 100) {
		throw new FormError(
			'Each access list supports up to 100 entries. Remove some entries first.'
		);
	}

	return { ...configuration, [category]: identifiers };
}
