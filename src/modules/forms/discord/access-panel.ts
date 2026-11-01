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
	allowRoles: 'Allowed roles',
	requiredRoles: 'Required roles',
	denyRoles: 'Blacklisted roles',
	blacklist: 'Blacklisted users'
} as const;

type AccessCategory = keyof typeof accessCategories;

export function blacklistSubject(category: string | undefined) {
	return category === 'blacklist' ? 'user' : category === 'denyRoles' ? 'role' : null;
}

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
		const explanation =
			category === 'allowRoles'
				? 'Applicants need any one of these roles. An empty list allows everyone.'
				: category === 'requiredRoles'
					? 'Applicants need every role in this list.'
					: 'Anyone matching this list is blocked from applying.';
		description = `### ${accessCategories[category]}\n${explanation}\n-# ${identifiers.length} ${noun} configured. Select up to 25 at a time to add or remove.\n-# ${blacklistSubject(category) ? 'Blacklist changes apply immediately, including to the published form.' : 'Changes stay in the draft until you publish.'}`;

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

	const categoryButtons = Object.entries(accessCategories).map(([category, label]) =>
		button(`${prefix}:${category}:open`, label).setDisabled(category === requestedCategory)
	);
	controls.push(buttons(...categoryButtons.slice(0, 2)), buttons(...categoryButtons.slice(2)));

	controls.push(buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')));

	return panel(`## ${safe(form.data.name)} — Applicant access\n\n${description}`, controls);
}

export function readAccessChange(interaction: AnySelectMenuInteraction, segments: string[]) {
	const category = accessCategory(segments[4]!);
	const operation = segments[5];

	if (
		category === 'blacklist' ? !interaction.isUserSelectMenu() : !interaction.isRoleSelectMenu()
	) {
		throw new FormError('Use the matching user or role selector.');
	}

	if (operation !== 'add' && operation !== 'remove') {
		throw new FormError('Choose whether to add or remove entries.');
	}

	return {
		category,
		adding: operation === 'add',
		selected: interaction.values,
		revision: Number(segments[6])
	};
}

export function updateAccessList(
	configuration: FormConfiguration,
	change: ReturnType<typeof readAccessChange>
): FormConfiguration {
	const { category, adding, selected, revision } = change;

	if (configuration.revision !== revision) {
		throw new FormError(
			'This access list changed. Reopen Access before making another change.'
		);
	}

	const identifiers = adding
		? [...new Set([...configuration[category], ...selected])]
		: configuration[category].filter((identifier) => !selected.includes(identifier));

	if (identifiers.length > 100) {
		throw new FormError(
			'Each access list supports up to 100 entries. Remove some entries first.'
		);
	}

	return { ...configuration, [category]: identifiers };
}
