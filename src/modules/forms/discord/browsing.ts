import { and, eq, count, desc } from 'drizzle-orm';
import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	PermissionFlagsBits,
	type Client,
	type Guild
} from 'discord.js';
import { forms, submissions } from '../../../database/schema';
import { FormService } from '../services/form-service';
import { StaffPermissions } from '../services/staff-permissions';
import { FormError } from '../domain/rules';
import type { FormRecord } from '../domain/types';
import { panel, buttons, button, safe } from './components';

const pageSize = 10;

export function pagination(requestedPage: number, total: number, size = pageSize) {
	const pages = Math.max(1, Math.ceil(total / size));
	const page = Number.isSafeInteger(requestedPage)
		? Math.max(0, Math.min(requestedPage, pages - 1))
		: 0;
	return { page, pages, offset: page * size };
}

function navigation(prefix: string, page: number, pages: number) {
	return buttons(
		button(`${prefix}:${page - 1}`, 'Previous').setDisabled(page === 0),
		button(`${prefix}:${page + 1}`, 'Next').setDisabled(page === pages - 1)
	);
}

export class FormBrowsing {
	public constructor(
		private readonly formService: FormService,
		private readonly permissions: StaffPermissions,
		private readonly client: Client
	) {}

	public async assertManagement(guild: Guild, actorId: string) {
		const identity = await this.permissions.identify(guild, actorId);
		await this.permissions.assertAny(
			guild.id,
			['forms.create', 'forms.edit', 'forms.publish', 'forms.archive', 'forms.blacklist'],
			identity
		);
	}

	public async assertChannelReader(form: FormRecord, guild: Guild, actorId: string) {
		if (form.guildId !== guild.id) {
			throw new FormError('This form belongs to another server.');
		}

		const channel = await this.client.channels.fetch(form.data.reviewChannelId);
		const member = await guild.members.fetch({ user: actorId, force: true });

		if (
			!channel ||
			!('permissionsFor' in channel) ||
			!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
		) {
			throw new FormError(
				'You need access to the submission channel to browse its submissions.'
			);
		}
	}

	public async forms(guild: Guild, actorId: string, requestedPage = 0) {
		await this.assertManagement(guild, actorId);
		const [totals] = await this.formService.database
			.select({ total: count() })
			.from(forms)
			.where(eq(forms.guildId, guild.id));
		const { page, pages, offset } = pagination(requestedPage, totals?.total ?? 0);
		const records = await this.formService.database
			.select()
			.from(forms)
			.where(eq(forms.guildId, guild.id))
			.orderBy(forms.id)
			.limit(pageSize)
			.offset(offset);
		const description = records
			.map(
				(form) =>
					`${safe(form.data.name)} · ${form.archived ? 'archived' : form.published ? 'published' : 'draft'}\n${form.id}`
			)
			.join('\n\n');
		const controls = [navigation(`zf:b:forms:${actorId}`, page, pages)];

		if (records.length) {
			const menu = new StringSelectMenuBuilder()
				.setCustomId(`zf:b:open:${actorId}`)
				.setPlaceholder('Open a form')
				.addOptions(records.map((form) => ({ label: form.data.name, value: form.id })));
			return panel(`## Server forms\n${description}\n\nPage ${page + 1} of ${pages}`, [
				...controls,
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
			]);
		}

		return panel(
			`## Server forms\nNo forms yet. Use /form create.\nPage ${page + 1} of ${pages}`,
			controls
		);
	}

	public async submissions(guild: Guild, formId: string, actorId: string, requestedPage = 0) {
		const form = await this.formService.findForm(formId);
		await this.assertChannelReader(form, guild, actorId);
		const filter = and(eq(submissions.formId, formId), eq(submissions.guildId, guild.id));
		const [totals] = await this.formService.database
			.select({ total: count() })
			.from(submissions)
			.where(filter);
		const { page, pages, offset } = pagination(requestedPage, totals?.total ?? 0);
		const records = await this.formService.database
			.select()
			.from(submissions)
			.where(filter)
			.orderBy(desc(submissions.createdAt), submissions.id)
			.limit(pageSize)
			.offset(offset);
		const description = records
			.map(
				(submission) =>
					`${submission.id}\n${submission.status} · review ${submission.deliveryState} · ${submission.archived ? 'archived' : 'open'}${submission.threadId ? ` · <#${submission.threadId}>` : ''}`
			)
			.join('\n\n');
		return panel(
			`## ${safe(form.data.name)} submissions\n${description || 'No submissions yet.'}\n\nPage ${page + 1} of ${pages}`,
			[navigation(`zf:b:submissions:${form.id}:${actorId}`, page, pages)]
		);
	}

	public async applicantSubmissions(actorId: string, requestedPage = 0) {
		const filter = eq(submissions.userId, actorId);
		const [totals] = await this.formService.database
			.select({ total: count() })
			.from(submissions)
			.where(filter);
		const { page, pages, offset } = pagination(requestedPage, totals?.total ?? 0);
		const records = await this.formService.database
			.select()
			.from(submissions)
			.where(filter)
			.orderBy(desc(submissions.createdAt), submissions.id)
			.limit(pageSize)
			.offset(offset);
		const description = records
			.map(
				(submission) =>
					`${safe(submission.snapshot.name)} — ${submission.status}${submission.archived ? ' · archived' : ''}\n${submission.id}`
			)
			.join('\n\n');
		return panel(
			`## Your submissions\n${description || 'You have no submissions yet.'}\n\nPage ${page + 1} of ${pages}`,
			[
				navigation(`zf:b:mine:${actorId}`, page, pages),
				buttons(button('zf:directory:page:0', 'Back to forms'))
			]
		);
	}

	public preview(form: FormRecord, actorId: string, requestedPage = 0) {
		const previewPages = form.data.questions.flatMap((question, index) => {
			let details = `Question ${index + 1} of ${form.data.questions.length}\n### ${safe(question.prompt)}\nType: ${question.type} · ${question.required ? 'required' : 'optional'}`;

			if (question.type === 'text')
				details += `\nLength: ${question.min}–${question.max} characters`;
			if (question.type === 'number')
				details += `\nRange: ${question.min}–${question.max}${question.integer ? ' (whole numbers)' : ''}`;
			if (question.type === 'choice')
				details += `\n${question.options.map((choice, choiceIndex) => `${choiceIndex + 1}. ${safe(choice)}`).join('\n')}`;
			if (question.type === 'attachment')
				details += '\nAttach 1–3 files, up to 8 MiB each and 20 MiB for the questionnaire.';

			return details.match(/[\s\S]{1,2200}/g) ?? [details];
		});
		const { page, pages } = pagination(requestedPage, previewPages.length, 1);
		return panel(
			`## Preview: ${safe(form.data.name)}\n${safe(form.data.description)}\n\n${previewPages[page] ?? 'No questions yet.'}\n\nPage ${page + 1} of ${pages}`,
			[
				navigation(`zf:b:preview:${form.id}:${actorId}:${form.data.revision}`, page, pages),
				buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form'))
			]
		);
	}
}
