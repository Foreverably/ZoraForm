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

	return `<t:${seconds}:D> · <t:${seconds}:R>`;
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

export function applicantCard(user: User, member: GuildMember | null, formName: string) {
	const container = new ContainerBuilder();
	const bannerUrl = user.bannerURL({ size: 1024 });

	if (user.accentColor) {
		container.setAccentColor(user.accentColor);
	}

	if (bannerUrl) {
		container.addMediaGalleryComponents((gallery) =>
			gallery.addItems((item) => item.setURL(bannerUrl))
		);
	}

	container.addSectionComponents(
		new SectionBuilder()
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`-# New submission · ${safe(formName)}\n## ${safe(member?.displayName ?? user.displayName)}\n<@${user.id}>`
				)
			)
			.setThumbnailAccessory(
				new ThumbnailBuilder().setURL(user.displayAvatarURL({ size: 256 }))
			)
	);

	const details = [
		`**Username:** ${safe(user.username)}`,
		`**Display name:** ${safe(user.globalName ?? user.username)}`,
		...(member?.nickname ? [`**Server nickname:** ${safe(member.nickname)}`] : []),
		`**User ID:** \`${user.id}\``,
		`**Account created:** ${discordDate(user.createdTimestamp)}`,
		`**Member since:** ${member?.joinedTimestamp ? discordDate(member.joinedTimestamp) : member ? 'Unknown' : 'Not in this server'}`,
		...(member?.premiumSinceTimestamp
			? [`**Boosting since:** ${discordDate(member.premiumSinceTimestamp)}`]
			: []),
		...(member ? [`**Roles:** ${roleList(member)}`] : [])
	];
	container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join('\n')));

	return {
		components: [container],
		flags: MessageFlags.IsComponentsV2 as const,
		allowedMentions: { parse: [] }
	};
}
