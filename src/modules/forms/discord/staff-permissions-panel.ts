import {
	ActionRowBuilder,
	RoleSelectMenuBuilder,
	StringSelectMenuBuilder,
	UserSelectMenuBuilder,
	type AnySelectMenuInteraction,
	type ButtonInteraction
} from 'discord.js';
import {
	staffCapabilities,
	type PermissionSubject,
	type StaffCapability,
	type StaffIdentity
} from '../domain/permissions';
import { FormError } from '../domain/rules';
import { FormService } from '../services/form-service';
import { StaffPermissions } from '../services/staff-permissions';
import { button, buttons, panelSections } from './components';

const capabilityDetails: Record<StaffCapability, { label: string; description: string }> = {
	'forms.create': { label: 'Create forms', description: 'Create new form drafts.' },
	'forms.edit': {
		label: 'Edit forms',
		description: 'Change questions, details, access rules, limits and the submission channel.'
	},
	'forms.publish': { label: 'Publish forms', description: 'Publish or reopen a form.' },
	'forms.archive': { label: 'Archive forms', description: 'Close a form to applicants.' },
	'forms.blacklist': {
		label: 'Blacklist',
		description: 'Block or unblock users and roles on a form.'
	},
	'submissions.decide': {
		label: 'Decide submissions',
		description: 'Accept or reject a submission.'
	},
	'submissions.reply': {
		label: 'Reply to applicants',
		description: 'Send an applicant a staff reply.'
	},
	'submissions.repair': {
		label: 'Recover deliveries',
		description: 'Recover a submission whose delivery failed.'
	}
};

const permissionAccentColor = 0x5865f2;
const maximumSelectedSubjects = 25;

function countLabel(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isCapability(value: string | undefined): value is StaffCapability {
	return staffCapabilities.includes(value as StaffCapability);
}

export class StaffPermissionsPanel {
	public constructor(
		private readonly formService: FormService,
		private readonly permissions: StaffPermissions
	) {}

	public async overview(guildId: string, identity: StaffIdentity) {
		this.permissions.assertCanConfigure(identity);
		const grants = await this.permissions.listGrants(guildId);
		const rows = staffCapabilities.map((capability) => {
			const granted = grants.filter((grant) => grant.capability === capability);
			const roles = granted.filter((grant) => grant.subjectType === 'role').length;
			const users = granted.length - roles;

			return {
				capability,
				summary: granted.length
					? `${countLabel(roles, 'role')} · ${countLabel(users, 'user')}`
					: 'Server managers only'
			};
		});

		return panelSections([
			{
				accentColor: permissionAccentColor,
				text: `## Staff permissions\nMembers with Manage Server or Administrator always have every permission. Choose one to give it to more roles or users.\n\n${rows
					.map(
						({ capability, summary }) =>
							`**${capabilityDetails[capability].label}** · ${summary}`
					)
					.join('\n')}`
			},
			{
				rows: [
					new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						new StringSelectMenuBuilder()
							.setCustomId(`zf:p:${identity.userId}:open`)
							.setPlaceholder('Choose a permission')
							.addOptions(
								staffCapabilities.map((capability) => ({
									label: capabilityDetails[capability].label,
									description: capabilityDetails[capability].description,
									value: capability
								}))
							)
					)
				]
			}
		]);
	}

	private async subjects(
		guildId: string,
		capability: StaffCapability,
		subjectType: PermissionSubject
	) {
		const grants = await this.permissions.listGrants(guildId);

		return grants
			.filter((grant) => grant.capability === capability && grant.subjectType === subjectType)
			.map((grant) => grant.subjectId)
			.sort();
	}

	private async detail(guildId: string, actorId: string, capability: StaffCapability) {
		const { label, description } = capabilityDetails[capability];
		const roles = await this.subjects(guildId, capability, 'role');
		const users = await this.subjects(guildId, capability, 'user');
		const prefix = `zf:p:${actorId}:${capability}`;
		const roleSelect = new RoleSelectMenuBuilder()
			.setCustomId(`${prefix}:role`)
			.setPlaceholder('No roles have this permission')
			.setMinValues(0)
			.setMaxValues(maximumSelectedSubjects);
		const userSelect = new UserSelectMenuBuilder()
			.setCustomId(`${prefix}:user`)
			.setPlaceholder('No users have this permission')
			.setMinValues(0)
			.setMaxValues(maximumSelectedSubjects);

		if (roles.length) {
			roleSelect.setDefaultRoles(...roles.slice(0, maximumSelectedSubjects));
		}

		if (users.length) {
			userSelect.setDefaultUsers(...users.slice(0, maximumSelectedSubjects));
		}

		const hiddenEntries =
			Math.max(0, roles.length - maximumSelectedSubjects) +
			Math.max(0, users.length - maximumSelectedSubjects);

		return panelSections([
			{
				accentColor: permissionAccentColor,
				text: `-# Staff permission\n### ${label}\n${description}`
			},
			{
				text: `Add or remove roles and users below. Changes apply immediately.${hiddenEntries ? `\n-# ${hiddenEntries} more not shown here keep this permission.` : ''}`,
				rows: [
					new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect),
					new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect)
				]
			},
			{ rows: [buttons(button(`zf:p:${actorId}:back`, 'All permissions'))] }
		]);
	}

	private async saveSelection(
		interaction: AnySelectMenuInteraction,
		identity: StaffIdentity,
		guildId: string,
		capability: StaffCapability,
		subjectType: PermissionSubject
	) {
		const shown = (await this.subjects(guildId, capability, subjectType)).slice(
			0,
			maximumSelectedSubjects
		);
		const changes = [
			...interaction.values
				.filter((subjectId) => !shown.includes(subjectId))
				.map((subjectId) => ({ subjectId, allowed: true })),
			...shown
				.filter((subjectId) => !interaction.values.includes(subjectId))
				.map((subjectId) => ({ subjectId, allowed: false }))
		];

		for (const { subjectId, allowed } of changes) {
			await this.permissions.configure(
				guildId,
				identity,
				capability,
				subjectType,
				subjectId,
				allowed
			);
			await this.formService.recordAuditEvent(
				this.formService.database,
				guildId,
				identity.userId,
				'staff.permission.configure',
				`${capability}:${subjectType}:${subjectId}:${allowed ? 'grant' : 'revoke'}`
			);
		}
	}

	public async handle(interaction: ButtonInteraction | AnySelectMenuInteraction) {
		const guild = interaction.guild;

		if (!guild) {
			throw new FormError('Manage staff permissions from a server.');
		}

		const [, , ownerId, action, subject] = interaction.customId.split(':');

		if (ownerId !== interaction.user.id) {
			throw new FormError('Open your own panel with /form permissions.');
		}

		const identity = await this.permissions.identify(guild, interaction.user.id);
		this.permissions.assertCanConfigure(identity);
		await interaction.deferUpdate();

		if (action === 'back') {
			await interaction.editReply(await this.overview(guild.id, identity));
			return;
		}

		const capability =
			action === 'open' && interaction.isStringSelectMenu() ? interaction.values[0] : action;

		if (!isCapability(capability)) {
			throw new FormError('Choose a supported staff permission.');
		}

		if (action !== 'open') {
			if (subject === 'role' && interaction.isRoleSelectMenu()) {
				await this.saveSelection(interaction, identity, guild.id, capability, 'role');
			} else if (subject === 'user' && interaction.isUserSelectMenu()) {
				await this.saveSelection(interaction, identity, guild.id, capability, 'user');
			} else {
				throw new FormError('Use the matching role or user selector.');
			}
		}

		await interaction.editReply(await this.detail(guild.id, identity.userId, capability));
	}
}
