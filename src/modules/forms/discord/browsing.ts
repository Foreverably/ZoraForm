import { QuestionMedia } from '../services/question-media';
import { and, eq, count, desc } from 'drizzle-orm';
import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	PermissionFlagsBits,
	type Client,
	type Guild,
	type GuildMember
} from 'discord.js';
import { forms, submissions } from '../../../database/schema';
import { FormService } from '../services/form-service';
import { StaffPermissions } from '../services/staff-permissions';
import { describeNumberLimits, describeTextLimits, FormError } from '../domain/rules';
import type { FormRecord } from '../domain/types';
import { panel, buttons, button, questionHeading, safe } from './components';

const pageSize = 10;

export function pagination(requestedPage: number, total: number, size = pageSize) {
	const pages = Math.max(1, Math.ceil(total / size));
	const page = Number.isSafeInteger(requestedPage)
		? Math.max(0, Math.min(requestedPage, pages - 1))
		: 0;
	return { page, pages, offset: page * size };
}

function formStatus(form: Pick<FormRecord, 'archived' | 'published'>) {
	return form.archived ? 'Archived' : form.published ? 'Published' : 'Draft';
}

function navigation(prefix: string, page: number, pages: number) {
	if (pages <= 1) {
		return [];
	}

	return [
		buttons(
			button(`${prefix}:${page - 1}`, 'Previous').setDisabled(page === 0),
			button(`${prefix}:${page + 1}`, 'Next').setDisabled(page === pages - 1)
		)
	];
}

export class FormBrowsing {
	public constructor(
		private readonly formService: FormService,
		private readonly permissions: StaffPermissions,
		private readonly client: Client,
		private readonly questionMedia = new QuestionMedia(client)
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

		const member = await guild.members.fetch({ user: actorId, force: true });

		if (!(await this.canReadChannel(form.data.reviewChannelId, member))) {
			throw new FormError(
				'You need access to the submission channel to browse its submissions.'
			);
		}
	}

	private async canReadChannel(channelId: string, member: GuildMember) {
		const channel = await this.client.channels.fetch(channelId).catch(() => null);

		return Boolean(
			channel &&
			'permissionsFor' in channel &&
			channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
		);
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
				(form, index) =>
					`${offset + index + 1}. **${safe(form.data.name)}** · \`${formStatus(form)}\``
			)
			.join('\n');
		const controls = navigation(`zf:b:forms:${actorId}`, page, pages);
		const footer = `-# ${totals?.total ?? 0} ${(totals?.total ?? 0) === 1 ? 'form' : 'forms'}${pages > 1 ? ` · Page ${page + 1} of ${pages}` : ''}`;

		if (records.length) {
			const menu = new StringSelectMenuBuilder()
				.setCustomId(`zf:b:open:${actorId}`)
				.setPlaceholder('Open a form')
				.addOptions(records.map((form) => ({ label: form.data.name, value: form.id })));
			return panel(
				`## Server forms\nSelect a form to manage its questions and settings.\n\n${description}\n\n${footer}`,
				[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), ...controls]
			);
		}

		return panel(
			`## Server forms\nNo forms yet. Use \`/form create\` to get started.`,
			controls
		);
	}

	public async submissionForms(guild: Guild, actorId: string, requestedPage = 0) {
		const member = await guild.members.fetch({ user: actorId, force: true });
		const readableForms = [];

		for (const form of await this.formService.listForms(guild.id)) {
			if (await this.canReadChannel(form.data.reviewChannelId, member)) {
				readableForms.push(form);
			}
		}

		const { page, pages, offset } = pagination(requestedPage, readableForms.length);
		const records = readableForms.slice(offset, offset + pageSize);
		const controls = navigation(`zf:b:read:${actorId}`, page, pages);

		if (!records.length) {
			return panel(
				'## Submissions\nNo forms send submissions to a channel you can read.',
				controls
			);
		}

		const description = records
			.map(
				(form, index) =>
					`${offset + index + 1}. **${safe(form.data.name)}** · \`${formStatus(form)}\``
			)
			.join('\n');
		const menu = new StringSelectMenuBuilder()
			.setCustomId(`zf:b:readopen:${actorId}`)
			.setPlaceholder('Choose a form')
			.addOptions(records.map((form) => ({ label: form.data.name, value: form.id })));

		return panel(
			`## Submissions\nChoose a form to browse its submissions.\n\n${description}${pages > 1 ? `\n\n-# Page ${page + 1} of ${pages}` : ''}`,
			[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), ...controls]
		);
	}

	public async submissions(
		guild: Guild,
		formId: string,
		actorId: string,
		requestedPage = 0,
		notice?: string
	) {
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
				(submission, index) =>
					`${offset + index + 1}. <@${submission.userId}> · \`${submission.userId}\` · **${submission.status}** · <t:${Math.floor(submission.createdAt.getTime() / 1000)}:R>\n   ${submission.archived ? 'archived' : 'open'} · delivery: \`${submission.deliveryState}\`${submission.threadId ? ` · <#${submission.threadId}>` : ''}`
			)
			.join('\n\n');
		const identity = await this.permissions.identify(guild, actorId);
		const recoverable = (await this.permissions.allowed(
			guild.id,
			'submissions.repair',
			identity
		))
			? records.flatMap((submission, index) =>
					submission.status === 'pending'
						? [
								{
									label: `${offset + index + 1}. ${submission.createdAt.toISOString().slice(0, 10)} · delivery: ${submission.deliveryState}`,
									value: submission.id
								}
							]
						: []
				)
			: [];
		const canEdit = await this.permissions.allowed(guild.id, 'forms.edit', identity);

		return panel(
			`## ${safe(form.data.name)} submissions\n${notice ? `${notice}\n\n` : ''}${description || 'No submissions yet.'}${pages > 1 ? `\n\n-# Page ${page + 1} of ${pages}` : ''}`,
			[
				...(recoverable.length
					? [
							new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
								new StringSelectMenuBuilder()
									.setCustomId(`zf:b:repair:${form.id}:${actorId}:${page}`)
									.setPlaceholder('Recover a failed delivery')
									.addOptions(recoverable)
							)
						]
					: []),
				...navigation(`zf:b:submissions:${form.id}:${actorId}`, page, pages),
				buttons(
					button(`zf:b:read:${actorId}:0`, 'Other forms'),
					...(canEdit ? [button(`zf:m:${form.id}:${actorId}:back`, 'Back to form')] : [])
				)
			]
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
					`- **${safe(submission.snapshot.name)}** · \`${submission.status}\`${submission.archived ? ' · archived' : ''}\n  ID: \`${submission.id}\``
			)
			.join('\n\n');
		return panel(
			`## Your submissions\n${description || 'You have no submissions yet.'}${pages > 1 ? `\n\n-# Page ${page + 1} of ${pages}` : ''}`,
			[
				...navigation(`zf:b:mine:${actorId}`, page, pages),
				buttons(button('zf:directory:page:0', 'Back to forms'))
			]
		);
	}

	public async preview(form: FormRecord, actorId: string, requestedPage = 0) {
		const previewPages = form.data.questions.flatMap((question, index) => {
			let details = `-# Question ${index + 1} of ${form.data.questions.length} · ${question.required ? 'Required' : 'Optional'} · ${question.type}\n\n${questionHeading(question.prompt)}`;

			if (question.type === 'text') details += `\nAnswer: ${describeTextLimits(question)}`;
			if (question.type === 'number')
				details += `\nAnswer: a number${describeNumberLimits(question) ? ` ${describeNumberLimits(question)}` : ''}`;
			if (question.type === 'choice')
				details += `\n${question.options.map((choice, choiceIndex) => `${choiceIndex + 1}. ${safe(choice)}`).join('\n')}`;
			if (question.type === 'attachment')
				details += '\nAttach 1–3 files, up to 8 MiB each and 20 MiB for the questionnaire.';

			return (details.match(/[\s\S]{1,2200}/g) ?? [details]).map((text) => ({
				text,
				question
			}));
		});
		const { page, pages } = pagination(requestedPage, previewPages.length, 1);
		const content = panel(
			`## Preview: ${safe(form.data.name)}\n${safe(form.data.description)}\n\n${previewPages[page]?.text ?? 'No questions yet.'}${pages > 1 ? `\n\n-# Page ${page + 1} of ${pages}` : ''}`,
			[
				...navigation(
					`zf:b:preview:${form.id}:${actorId}:${form.data.revision}`,
					page,
					pages
				),
				buttons(button(`zf:m:${form.id}:${actorId}:back`, 'Back to form'))
			]
		);
		return this.questionMedia.decorate(content, previewPages[page]?.question);
	}
}
