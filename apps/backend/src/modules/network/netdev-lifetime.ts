import { readFileSync, statSync } from "node:fs";
import { advanceNetifTopologyGeneration } from "./netif-topology-generation.ts";

// An operating-system refusal is unknown evidence about the netdev; any other
// exception is a fault in this process and must not be reported as evidence.
function readSysfs<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch (error) {
		if (error instanceof Error && "code" in error) return undefined;
		throw error;
	}
}

export const netdevPresence = {
	/** `false` only when sysfs reports the name absent; `undefined` when unreadable. */
	inSysfs(name: string): boolean | undefined {
		return readSysfs(
			() =>
				statSync(`/sys/class/net/${name}`, { throwIfNoEntry: false }) !==
				undefined,
		);
	},
	ifindex(name: string): number | undefined {
		const text = readSysfs(() =>
			readFileSync(`/sys/class/net/${name}/ifindex`, "utf8").trim(),
		);
		const index = Number(text);
		return text !== undefined &&
			/^\d+$/.test(text) &&
			Number.isSafeInteger(index) &&
			index > 0
			? index
			: undefined;
	},
};

export type NetdevWitness = {
	readonly ifindex: number | undefined;
	readonly node?: string | undefined;
	readonly mac?: string | undefined;
	/**
	 * Sysfs listed the name (`true`) or confirmed it absent (`false`). A recorded
	 * witness keeps the last confirmed answer across unreadable reads.
	 */
	readonly present?: boolean | undefined;
};

function readNode(name: string): string | undefined {
	return readSysfs(() => {
		const stat = statSync(`/sys/class/net/${name}`, {
			bigint: true,
			throwIfNoEntry: false,
		});
		return stat && `${stat.dev}:${stat.ino}`;
	});
}

export function readNetdevWitness(name: string): NetdevWitness {
	const present = netdevPresence.inSysfs(name);
	const node = readNode(name);
	const ifindex = netdevPresence.ifindex(name);
	return node === readNode(name)
		? { ifindex, node, present }
		: { ifindex: undefined, present };
}

export function netdevRunning(name: string): boolean {
	return (
		readSysfs(() =>
			readFileSync(`/sys/class/net/${name}/operstate`, "utf8").trim(),
		) === "up"
	);
}

const witnesses = new Map<string, NetdevWitness>();
const epochs = new Map<string, number>();
type RetirementListener = (
	name: string,
	epoch: number,
	fencePoll: boolean,
) => void;
const listeners = new Set<RetirementListener>();

export const netdevWitness = (name: string) => witnesses.get(name);
export const netdevLifetime = (name: string) => epochs.get(name);

function sameKernelNetdev(
	before: NetdevWitness | undefined,
	after: NetdevWitness,
): boolean {
	return (
		before?.node !== undefined &&
		before.node === after.node &&
		before.ifindex !== undefined &&
		before.ifindex === after.ifindex
	);
}

export function netdevChanged(
	before: NetdevWitness | undefined,
	after: NetdevWitness,
): boolean {
	if (before?.present === true && after.present === false) return true;
	if (sameKernelNetdev(before, after)) return false;
	return (["ifindex", "node", "mac"] as const).some((key) => {
		const old = before?.[key];
		const next = after[key];
		return old !== undefined && next !== undefined && old !== next;
	});
}

export function netdevMatches(
	before: NetdevWitness | undefined,
	after: NetdevWitness,
): boolean {
	return (
		(before?.node !== undefined && before.node === after.node) ||
		(before?.ifindex !== undefined && before.ifindex === after.ifindex)
	);
}

export function hasNetdevWitness(witness: NetdevWitness | undefined): boolean {
	return witness?.ifindex !== undefined || witness?.node !== undefined;
}

function netdevContinues(
	before: NetdevWitness | undefined,
	after: NetdevWitness,
): boolean {
	return netdevMatches(before, after) && !netdevChanged(before, after);
}

/**
 * Whether a request bound to the interface NAME still reaches the netdev it was
 * issued for. Continuity must be shown, not assumed: the issuing read must share
 * a matching index or node with the recorded witness, and every check re-reads
 * the live witness and requires the same of it. Missing, unreadable or
 * non-overlapping evidence refuses. This runs in this process before the
 * transport binds the name, so it narrows, not closes, the check-to-bind window.
 */
export function netdevLifetimeFence(name: string): () => boolean {
	const epoch = epochs.get(name);
	const issued = readNetdevWitness(name);
	const valid = netdevContinues(witnesses.get(name), issued);
	return () =>
		valid &&
		epochs.get(name) === epoch &&
		netdevContinues(issued, readNetdevWitness(name));
}

export function noteNetdevWitness(name: string, next: NetdevWitness): void {
	const old = witnesses.get(name);
	witnesses.set(name, {
		ifindex: next.ifindex ?? old?.ifindex,
		node: next.node ?? old?.node,
		mac: next.mac ?? old?.mac,
		present: next.present ?? old?.present,
	});
}

export function retireNetdev(name: string, fencePoll = true): void {
	witnesses.delete(name);
	const epoch = advanceNetifTopologyGeneration();
	epochs.set(name, epoch);
	for (const listener of listeners) listener(name, epoch, fencePoll);
}

export function onNetdevRetired(listener: RetirementListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function resetNetdevLifetimesForTest(): void {
	witnesses.clear();
	epochs.clear();
}
