import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { FormError, outdatedControl } from '../domain/rules';
import type { FormConfiguration, FormRecord } from '../domain/types';
import { button, buttons, panelSections, safe } from './components';

const limitsAccentColor = 0x5865f2;
const hourSeconds = 3600;
const daySeconds = 24 * hourSeconds;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function duration(seconds: number) {
	if (seconds % daySeconds === 0) {
		return plural(seconds / daySeconds, 'day');
	}

	if (seconds % hourSeconds === 0) {
		return plural(seconds / hourSeconds, 'hour');
	}

	return seconds % 60 === 0 ? plural(seconds / 60, 'minute') : plural(seconds, 'second');
}

const limitSettings = {
	totalLimit: {
		choices: [0, 1, 2, 3, 5, 10],
		label: (value: number) =>
			value === 0
				? 'Unlimited submissions per person'
				: `${plural(value, 'submission')} per person`
	},
	pendingLimit: {
		choices: [0, 1, 2, 3, 5],
		label: (value: number) =>
			value === 0
				? 'No limit on submissions waiting for review'
				: `${value} waiting for review at a time`
	},
	cooldownSeconds: {
		choices: [
			0,
			hourSeconds,
			6 * hourSeconds,
			12 * hourSeconds,
			daySeconds,
			3 * daySeconds,
			7 * daySeconds,
			14 * daySeconds,
			30 * daySeconds
		],
		label: (value: number) =>
			value === 0
				? 'No wait between submissions'
				: `Wait ${duration(value)} between submissions`
	}
} as const;

type LimitSetting = keyof typeof limitSettings;

export function limitsPanel(form: FormRecord, actorId: string) {
	const rows = (Object.keys(limitSettings) as LimitSetting[]).map((setting) => {
		const { choices, label } = limitSettings[setting];
		const current = form.data[setting];
		// A value saved before these menus existed stays selectable until it is changed.
		const values = [...new Set<number>([...choices, current])].sort(
			(first, second) => first - second
		);

		return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(`zf:limits:${form.id}:${actorId}:${setting}:${form.data.revision}`)
				.addOptions(
					values.map((value) => ({
						label: label(value),
						value: String(value),
						default: value === current
					}))
				)
		);
	});

	return panelSections([
		{
			accentColor: limitsAccentColor,
			text: `## ${safe(form.data.name)} — Submission limits\n**Submissions per person:** how many times one person can ever submit this form.\n**Waiting for review:** how many of their submissions can be undecided at once.\n**Wait between submissions:** how long they wait before submitting again.`
		},
		{ text: '-# Changes stay in the draft until you publish.', rows },
		{ rows: [buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form'))] }
	]);
}

export function updateLimit(
	configuration: FormConfiguration,
	segments: string[],
	selectedValue: string | undefined
): FormConfiguration {
	const setting = segments[4]!;

	if (!Object.hasOwn(limitSettings, setting)) {
		throw new FormError(outdatedControl);
	}

	if (configuration.revision !== Number(segments[5])) {
		throw new FormError(
			'These limits changed while this panel was open. Open them again from the form panel.'
		);
	}

	return { ...configuration, [setting]: Number(selectedValue) };
}
