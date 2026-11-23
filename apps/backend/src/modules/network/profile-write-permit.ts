/** A successful async check may carry evidence that must still hold at dispatch. */
export type ProfileWriteAdmission = boolean | (() => boolean);
export type ProfileWritePermit = (() => Promise<boolean>) & {
	readonly current?: () => boolean;
};

export function profileAdmissionCurrent(
	admission: ProfileWriteAdmission,
): boolean {
	return typeof admission === "function" ? admission() : admission;
}

export function profileWritePermit(
	check: () => Promise<ProfileWriteAdmission>,
): ProfileWritePermit {
	let admission: ProfileWriteAdmission = false;
	const current = () => profileAdmissionCurrent(admission);
	return Object.assign(
		async () => {
			admission = await check();
			return current();
		},
		{ current },
	);
}
