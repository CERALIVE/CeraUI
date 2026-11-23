/**
 * Every name each link carried during one streaming session, in the order the
 * names were seen. IngestStats records names alongside fresh telemetry.
 *
 * Keyed by a Map: an interface may be called anything, including an inherited
 * object property such as `constructor`. Plain data on purpose: nothing renders
 * from it until the session ends, and `snapshot()` hands out a copy.
 */
export interface SessionLinkNames {
	/** Record `name` for a session link key, unless it repeats the last name. */
	record(key: string, name: string): void;
	/** A copy of every link's names, in the order they were seen. */
	snapshot(): ReadonlyMap<string, readonly string[]>;
}

export function createSessionLinkNames(): SessionLinkNames {
	const names = new Map<string, string[]>();
	return {
		record(key, name) {
			const seen = names.get(key);
			if (!seen) names.set(key, [name]);
			else if (seen.at(-1) !== name) seen.push(name);
		},
		snapshot() {
			return new Map(
				[...names].map(([iface, seen]) => [iface, [...seen]] as const),
			);
		},
	};
}
