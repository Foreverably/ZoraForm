export const staffCapabilities = [
	'forms.create',
	'forms.edit',
	'forms.publish',
	'forms.archive',
	'forms.blacklist',
	'submissions.decide',
	'submissions.repair'
] as const;

export type StaffCapability = (typeof staffCapabilities)[number];

export const staffCapabilityActions: Record<StaffCapability, string> = {
	'forms.create': 'create forms',
	'forms.edit': 'edit forms',
	'forms.publish': 'publish forms',
	'forms.archive': 'archive forms',
	'forms.blacklist': 'change form blacklists',
	'submissions.decide': 'accept or reject submissions',
	'submissions.repair': 'recover submission deliveries'
};
export type PermissionSubject = 'user' | 'role';

export interface StaffIdentity {
	userId: string;
	roleIds: readonly string[];
	manageServer: boolean;
	administrator: boolean;
}
