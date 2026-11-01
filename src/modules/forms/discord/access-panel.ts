import {
	ActionRowBuilder,
	ContainerBuilder,
	RoleSelectMenuBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	UserSelectMenuBuilder,
	type AnySelectMenuInteraction
} from 'discord.js';
import { FormError, outdatedControl } from '../domain/rules';
import type { FormConfiguration, FormRecord } from '../domain/types';
import { button, buttons, containerPanel, safe } from './components';

const maximumSelectedEntries = 25;

const accessCategories = {
	allowRoles: {
		label: 'Allowed roles',
		description: 'Applicants need at least one of these. Empty lets everyone apply.',
		emptyPlaceholder: 'Everyone can apply'
	},
	requiredRoles: {
		label: 'Required roles',
		description: 'Applicants need all of these.',
		emptyPlaceholder: 'No required roles'
	},
	denyRoles: {
		label: 'Blacklisted roles',
		description: 'Anyone with one of these cannot apply. Applies immediately.',
		emptyPlaceholder: 'No blacklisted roles'
	},
	blacklist: {
		label: 'Blacklisted users',
		description: 'These people cannot apply. Applies immediately.',
		emptyPlaceholder: 'No blacklisted users'
	}
} as const;

type AccessCategory = keyof typeof accessCategories;

export function blacklistSubject(category: string | undefined) {
	return category === 'blacklist' ? 'user' : category === 'denyRoles' ? 'role' : null;
}

function accessCategory(value: string): AccessCategory {
	if (!Object.hasOwn(accessCategories, value)) {
		throw new FormError(outdatedControl);
	}

	return value as AccessCategory;
}

function categorySelector(form: FormRecord, actorId: string, category: AccessCategory) {
	const shownEntries = form.data[category].slice(0, maximumSelectedEntries);
	const customId = `zf:access:${form.id}:${actorId}:${category}:set:${form.data.revision}`;
	const placeholder = accessCategories[category].emptyPlaceholder;

	if (category === 'blacklist') {
		const selector = new UserSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.setMinValues(0)
			.setMaxValues(maximumSelectedEntries);

		if (shownEntries.length) {
			selector.setDefaultUsers(...shownEntries);
		}

		return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(selector);
	}

	const selector = new RoleSelectMenuBuilder()
		.setCustomId(customId)
		.setPlaceholder(placeholder)
		.setMinValues(0)
		.setMaxValues(maximumSelectedEntries);

	if (shownEntries.length) {
		selector.setDefaultRoles(...shownEntries);
	}

	return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(selector);
}

export function accessPanel(form: FormRecord, actorId: string) {
	const container = new ContainerBuilder().addTextDisplayComponents(
		new TextDisplayBuilder().setContent(
			`## ${safe(form.data.name)} — Applicant access\nBlacklists always take priority.`
		)
	);

	for (const category of Object.keys(accessCategories) as AccessCategory[]) {
		const { label, description } = accessCategories[category];
		const hiddenEntries = form.data[category].length - maximumSelectedEntries;

		container.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				`**${label}**\n-# ${description}${hiddenEntries > 0 ? ` ${hiddenEntries} more not shown here stay on the list.` : ''}`
			)
		);
		container.addActionRowComponents(categorySelector(form, actorId, category).toJSON());
	}

	container.addSeparatorComponents(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
	);
	container.addTextDisplayComponents(
		new TextDisplayBuilder().setContent(
			'-# Allowed and required roles stay in the draft until you publish.'
		)
	);
	container.addActionRowComponents(
		buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')).toJSON()
	);

	return containerPanel([container]);
}

export function readAccessChange(
	interaction: AnySelectMenuInteraction,
	segments: string[],
	configuration: FormConfiguration
) {
	const category = accessCategory(segments[4]!);

	if (segments[5] !== 'set') {
		throw new FormError(outdatedControl);
	}

	if (
		category === 'blacklist' ? !interaction.isUserSelectMenu() : !interaction.isRoleSelectMenu()
	) {
		throw new FormError(outdatedControl);
	}

	const shownEntries = configuration[category].slice(0, maximumSelectedEntries);

	return {
		category,
		added: interaction.values.filter((entry) => !configuration[category].includes(entry)),
		removed: shownEntries.filter((entry) => !interaction.values.includes(entry)),
		revision: Number(segments[6])
	};
}

export function updateAccessList(
	configuration: FormConfiguration,
	change: ReturnType<typeof readAccessChange>
): FormConfiguration {
	const { category, added, removed, revision } = change;

	if (configuration.revision !== revision) {
		throw new FormError(
			'This form changed while this panel was open. Open Access again and retry.'
		);
	}

	const identifiers = [
		...configuration[category].filter((identifier) => !removed.includes(identifier)),
		...added
	];

	if (identifiers.length > 100) {
		throw new FormError(
			'Each access list supports up to 100 entries. Remove some entries first.'
		);
	}

	return { ...configuration, [category]: identifiers };
}
