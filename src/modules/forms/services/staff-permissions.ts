import { and, eq, inArray, or } from 'drizzle-orm';
import type { Guild } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import type { Database, Queryable } from '../../../database/database';
import { staffGrants } from '../../../database/schema';
import { FormError, StaffPermissionError } from '../domain/rules';
import {
	staffCapabilityActions,
	type StaffCapability,
	type StaffIdentity,
	type PermissionSubject
} from '../domain/permissions';

const askForPermission = 'Ask a server manager to give it to you with `/form permissions`.';

export class StaffPermissions {
	public constructor(private readonly database: Database) {}

	public async identify(guild: Guild | null, userId: string): Promise<StaffIdentity> {
		if (!guild) {
			throw new FormError('Use this in a server, not in DMs.');
		}

		const member = await guild.members.fetch({ user: userId, force: true });

		return {
			userId,
			roleIds: [...member.roles.cache.keys()],
			manageServer: member.permissions.has(PermissionFlagsBits.ManageGuild),
			administrator: member.permissions.has(PermissionFlagsBits.Administrator)
		};
	}

	public async allowed(
		guildId: string,
		capability: StaffCapability,
		identity: StaffIdentity,
		database: Queryable = this.database
	) {
		if (identity.manageServer || identity.administrator) {
			return true;
		}

		const matchingGrants = await database
			.select()
			.from(staffGrants)
			.where(
				and(
					eq(staffGrants.guildId, guildId),
					eq(staffGrants.capability, capability),
					or(
						and(
							eq(staffGrants.subjectType, 'user'),
							eq(staffGrants.subjectId, identity.userId)
						),
						and(
							eq(staffGrants.subjectType, 'role'),
							inArray(staffGrants.subjectId, [...identity.roleIds])
						)
					)
				)
			)
			.limit(1);

		return matchingGrants.length > 0;
	}

	public async assertAllowed(
		guildId: string,
		capability: StaffCapability,
		identity: StaffIdentity,
		database: Queryable = this.database
	) {
		if (!(await this.allowed(guildId, capability, identity, database))) {
			throw new StaffPermissionError(
				`You don't have permission to ${staffCapabilityActions[capability]}. ${askForPermission}`
			);
		}
	}

	public async assertAny(
		guildId: string,
		capabilities: readonly StaffCapability[],
		identity: StaffIdentity
	) {
		for (const capability of capabilities) {
			if (await this.allowed(guildId, capability, identity)) {
				return;
			}
		}

		throw new StaffPermissionError(
			`You don't have permission to manage forms. ${askForPermission}`
		);
	}

	public assertCanConfigure(identity: StaffIdentity) {
		if (!identity.manageServer && !identity.administrator) {
			throw new StaffPermissionError(
				'Only members with Manage Server or Administrator can change staff permissions.'
			);
		}
	}

	public listGrants(guildId: string) {
		return this.database.select().from(staffGrants).where(eq(staffGrants.guildId, guildId));
	}

	public async configure(
		guildId: string,
		identity: StaffIdentity,
		capability: StaffCapability,
		subjectType: PermissionSubject,
		subjectId: string,
		allowed: boolean
	) {
		this.assertCanConfigure(identity);

		const matchingGrant = and(
			eq(staffGrants.guildId, guildId),
			eq(staffGrants.capability, capability),
			eq(staffGrants.subjectType, subjectType),
			eq(staffGrants.subjectId, subjectId)
		);

		if (allowed) {
			await this.database
				.insert(staffGrants)
				.values({ guildId, capability, subjectType, subjectId })
				.onConflictDoNothing();
		} else {
			await this.database.delete(staffGrants).where(matchingGrant);
		}
	}
}
