/**
 * Every name each link carried during one streaming session, in the order the
 * names were seen. IngestStats records a link's name with each sample, so a SIM
 * that registered on another operator mid-session can read "SIM 1 · A → B" in
 * the session summary instead of the name at viewing time.
 *
 * Keyed by a Map: an interface may be called anything, including an inherited
 * object property such as `constructor`. Plain data on purpose: nothing renders
 * from it until the session ends, and `snapshot()` hands out a copy.
 */
export interface SessionLinkNames {
	/** Record `name` for `iface`, unless it repeats the last name seen. */
	record(iface: string, name: string): void;
	/** A copy of every link's names, in the order they were seen. */
	snapshot(): ReadonlyMap<string, readonly string[]>;
}

export function createSessionLinkNames(): SessionLinkNames {
	const names = new Map<string, string[]>();
	return {
		record(iface, name) {
			const seen = names.get(iface);
			if (!seen) names.set(iface, [name]);
			else if (seen.at(-1) !== name) seen.push(name);
		},
		snapshot() {
			return new Map(
				[...names].map(([iface, seen]) => [iface, [...seen]] as const),
			);
		},
	};
}
