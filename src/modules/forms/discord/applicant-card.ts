import {
	ContainerBuilder,
	MessageFlags,
	SectionBuilder,
	TextDisplayBuilder,
	ThumbnailBuilder,
	type GuildMember,
	type User
} from 'discord.js';
import { safe } from './components';

const maximumListedRoles = 30;

function discordDate(timestamp: number) {
	const seconds = Math.floor(timestamp / 1000);

	return `<t:${seconds}:D> - <t:${seconds}:R>`;
}

function roleList(member: GuildMember) {
	const roles = member.roles.cache
		.filter((_, roleId) => roleId !== member.guild.id)
		.sort((first, second) => second.position - first.position)
		.map((_, roleId) => `<@&${roleId}>`);

	if (!roles.length) {
		return 'None';
	}

	const hiddenRoles = roles.length - maximumListedRoles;

	return `${roles.slice(0, maximumListedRoles).join(' ')}${hiddenRoles > 0 ? ` and ${hiddenRoles} more` : ''}`;
}

export function reviewThreadName(user: User, formName: string) {
	return `${user.username} - ${formName}`.slice(0, 100);
}

export interface CardSubmission {
	snapshot: { name: string };
	status: 'pending' | 'accepted' | 'rejected';
	reviewerId: string | null;
}

const cardStatus = {
	pending: { accentColor: 0xfee75c, label: '(Waiting for review)' },
	accepted: { accentColor: 0x57f287, label: '(Accepted)' },
	rejected: { accentColor: 0xed4245, label: '(Rejected)' }
} as const;

export function applicantCard(user: User, member: GuildMember | null, submission: CardSubmission) {
	const { accentColor, label } = cardStatus[submission.status];
	void member;
	const container = new ContainerBuilder().setAccentColor(accentColor);

	const details = [
		`-# **Account created:** ${discordDate(user.createdTimestamp)}`,
		`-# **Joined server:** ${member?.joinedTimestamp ? discordDate(member.joinedTimestamp) : member ? 'Unknown' : 'Not in this server'}`,
		...(member?.premiumSinceTimestamp
			? [`-# **Boosting since:** ${discordDate(member.premiumSinceTimestamp)}`]
			: []),
		...(member ? [`-# **Roles:** ${roleList(member)}`] : []),
		`-# User ID: \`${user.id}\``
	];

	container.addSectionComponents(
		new SectionBuilder()
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`## <@${user.id}>'s ${safe(submission.snapshot.name)}\n**${label}**${submission.reviewerId ? ` by <@${submission.reviewerId}>` : ''}\n${details.join('\n')}`
				)
			)
			.setThumbnailAccessory(
				new ThumbnailBuilder().setURL(user.displayAvatarURL({ size: 256 }))
			)
	);


	return {
		components: [container],
		flags: MessageFlags.IsComponentsV2 as const,
		allowedMentions: { parse: [] }
	};
}
