export const staffCapabilities = [
	'forms.create',
	'forms.edit',
	'forms.publish',
	'forms.archive',
	'forms.blacklist',
	'submissions.decide',
	'submissions.reply',
	'submissions.repair'
] as const;

export type StaffCapability = (typeof staffCapabilities)[number];
export type PermissionSubject = 'user' | 'role';

export interface StaffIdentity {
	userId: string;
	roleIds: readonly string[];
	manageServer: boolean;
	administrator: boolean;
}
