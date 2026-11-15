// Tickets reserve sharing for 60 seconds; an active download owns it until joined.
let owner: { expiresAt: number } | null = null;

export function reserveLogSharing(now = Date.now()) {
	if (owner && owner.expiresAt > now) return null;
	const lease = { expiresAt: now + 60_000 };
	owner = lease;
	return {
		start() {
			lease.expiresAt = Infinity;
		},
		release() {
			if (owner === lease) owner = null;
		},
	};
}
