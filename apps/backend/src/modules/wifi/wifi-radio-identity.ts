import { readdir, realpath } from "node:fs/promises";
import { getNetifTopologyGeneration } from "../network/netif-topology-generation.ts";
import type { MacAddress } from "../network/network-manager.ts";
import { runIw } from "./regdomain.ts";
import type {
	BaseWifiInterface,
	WifiAdapterDegradedReason,
} from "./wifi-interfaces.ts";
import { invalidateWifiRadioRow } from "./wifi-radio-publication.ts";
import { type RadioSample, sampleRadio } from "./wifi-radio-read-budget.ts";

export type RadioLifetime = {
	readonly ifindex: number;
	readonly wiphy: number;
	readonly phyPath: string;
};

export type RadioIdentity = {
	readonly ifname: string;
	readonly key: string;
	readonly lifetime: RadioLifetime | undefined;
	readonly permanentMac: MacAddress | undefined;
	readonly devicePath?: string;
	readonly classification: "verified" | "limited" | "unverified";
	readonly degradedReason: WifiAdapterDegradedReason | undefined;
	readonly incarnation: string;
	readonly row?: BaseWifiInterface;
	readonly observation?: number;
};

export type RadioIdentityReaders = {
	readonly readText: (path: string) => Promise<string | undefined>;
	readonly realpath: (path: string) => Promise<string | undefined>;
	readonly readDevicePath?: (ifname: string) => Promise<string | undefined>;
};

let shadowFailures = 0;

export function recordWifiRadioShadowFailure(): void {
	shadowFailures++;
}

export function getWifiRadioShadowFailures(): number {
	return shadowFailures;
}

type RadioRosterReaders = RadioIdentityReaders & {
	readonly listInterfaces: () => Promise<string[] | undefined>;
	readonly readPhyInventory: () => Promise<string>;
};

// The bracketed lifetime sample owns adapter identity.
export const radioIdentityReaders: RadioRosterReaders = {
	listInterfaces: () => readdir("/sys/class/net").catch(() => undefined),
	readPhyInventory: () => runIw(["phy"]),
	readDevicePath: async (ifname) => {
		const { nmDeviceProp } = await import("../network/network-manager.ts");
		return (await nmDeviceProp(ifname, "GENERAL.PATH"))?.[0];
	},
	readText: (path) =>
		Bun.file(path)
			.text()
			.catch(() => {
				recordWifiRadioShadowFailure();
				return undefined;
			}),
	realpath: (path) =>
		realpath(path).catch(() => {
			recordWifiRadioShadowFailure();
			return undefined;
		}),
};

export type RadioObservation = {
	readonly ifname: string;
	readonly degradedReason?: WifiAdapterDegradedReason;
	readonly row?: BaseWifiInterface;
};

export function sameRadioLifetime(
	a: RadioLifetime | undefined,
	b: RadioLifetime | undefined,
): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		a.ifindex === b.ifindex &&
		a.wiphy === b.wiphy &&
		a.phyPath === b.phyPath
	);
}

export type RadioIdentityState = {
	readonly rows: ReadonlyMap<string, RadioIdentity>;
	readonly changed: readonly string[];
};

/** Only a same-phy AP leg is redundant for physical port occupancy. */
export function wifiPhysicalPortWitnesses(
	rows: ReadonlyMap<string, RadioIdentity>,
) {
	const radios = [...rows.values()];
	const parentPhys = new Set(
		radios
			.filter((row) => !row.ifname.startsWith("clap-"))
			.map((row) => row.lifetime?.phyPath),
	);
	return radios.filter(
		(row) =>
			!row.ifname.startsWith("clap-") ||
			!row.lifetime ||
			!parentPhys.has(row.lifetime.phyPath),
	);
}

type CompleteRadioInventory = {
	readonly kind: "complete";
	readonly rows: ReadonlyMap<string, RadioIdentity>;
};

const unknownInventory = { kind: "unknown" } as const;
type RadioInventory = CompleteRadioInventory | typeof unknownInventory;
export type ReadRadioInventory = (() => Promise<RadioInventory>) & {
	readonly current: () => boolean;
};

/** Reuse one kernel inventory within a pass, never across identity samples. */
export function radioInventoryFor(
	rows = wifiRadioIdentity.state.rows,
): ReadRadioInventory {
	const observation =
		rows === wifiRadioIdentity.state.rows
			? wifiRadioIdentity.publishedObservation
			: undefined;
	const topologyGeneration = wifiRadioIdentity.publishedTopologyGeneration;
	const isCurrent = () =>
		observation !== undefined &&
		observation === wifiRadioIdentity.publishedObservation &&
		topologyGeneration === getNetifTopologyGeneration();
	let probe: Promise<RadioInventory> | undefined;
	return Object.assign(
		async () => {
			if (!isCurrent()) return unknownInventory;
			probe ??= proveRadioInventory(rows);
			const proof = await probe;
			return isCurrent() ? proof : unknownInventory;
		},
		{ current: isCurrent },
	);
}

/** Absence claims need the complete kernel PHY set, not just NM's selected rows. */
async function proveRadioInventory(
	rows: ReadonlyMap<string, RadioIdentity>,
): Promise<RadioInventory> {
	const expected = new Map<string, string>();
	for (const radio of rows.values()) {
		const path = radio.lifetime?.phyPath;
		const phy = path?.split("/").at(-1);
		if (!path || !phy || (expected.has(phy) && expected.get(phy) !== path))
			return unknownInventory;
		expected.set(phy, path);
	}
	try {
		const dump = await radioIdentityReaders.readPhyInventory();
		const seen = new Set<string>();
		for (const line of dump.split("\n")) {
			if (!line.trim() || /^\s/.test(line)) continue;
			const phy = /^Wiphy\s+(\S+)\s*$/.exec(line)?.[1];
			if (!phy || seen.has(phy) || !expected.has(phy)) return unknownInventory;
			seen.add(phy);
		}
		return seen.size === expected.size && (seen.size > 0 || !dump.trim())
			? { kind: "complete", rows }
			: unknownInventory;
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return unknownInventory;
	}
}

/**
 * Coherent lifetime evidence selects registry keys before discovery publishes.
 */
export class WifiRadioIdentityProducer {
	private permanentMacByLifetime = new Map<string, MacAddress>();
	private readonly sameAddressCollisions = new Set<MacAddress>();
	private snapshot: RadioIdentityState = { rows: new Map(), changed: [] };
	private sequence = 0;
	private publishedSequence = 0;
	private sampledTopologyGeneration: number | undefined;
	// Discovery can publish rows before a capacity-deferred sample begins.
	private observedRows = new Map<string, BaseWifiInterface>();

	constructor(private readonly readers: RadioIdentityReaders) {}

	get state(): RadioIdentityState {
		return this.snapshot;
	}

	hasSeenSameAddressCollision(mac: MacAddress): boolean {
		return this.sameAddressCollisions.has(mac);
	}

	resetCollisionHistoryForTest(): void {
		this.sameAddressCollisions.clear();
	}

	get publishedObservation(): number {
		return this.publishedSequence;
	}

	get publishedTopologyGeneration(): number | undefined {
		return this.sampledTopologyGeneration;
	}

	captureObservation(): number {
		this.observedRows.clear();
		return ++this.sequence;
	}

	associateRows(rows: readonly BaseWifiInterface[], sequence: number): void {
		if (sequence !== this.sequence) return;
		for (const row of rows) this.observedRows.set(row.ifname, row);
		if (sequence !== this.publishedSequence) return;
		const associated = new Map(this.snapshot.rows);
		for (const row of rows) {
			const identity = associated.get(row.ifname);
			if (!identity) continue;
			invalidateWifiRadioRow(row, sequence);
			associated.set(row.ifname, { ...identity, row, observation: sequence });
		}
		this.snapshot = { ...this.snapshot, rows: associated };
	}

	async discover(
		devices: readonly RadioObservation[],
		sequence?: number,
		signal?: AbortSignal,
		topologyGeneration = getNetifTopologyGeneration(),
	): Promise<void> {
		const generation = sequence ?? this.captureObservation();
		if (signal?.aborted || generation < this.publishedSequence) return;
		if (sequence === undefined) {
			for (const device of devices) {
				if (device.row) invalidateWifiRadioRow(device.row, generation);
			}
		}
		const cache = new Map(this.permanentMacByLifetime);
		const samples = new Map<string, RadioSample | undefined>();
		const seen = new Set<string>();
		const macPaths = new Map<MacAddress, Set<string>>();
		const pathByPhy = new Map<string, string>();
		const interfacesByPhy = new Map<string, number>();
		const devicePaths = new Map<string, Set<string>>();
		// Finish classification before publishing any healthy identity edge.
		for (const { ifname } of devices) {
			const sample = await sampleRadio(ifname, this.readers, signal);
			if (signal?.aborted) return;
			if (sample) {
				const pair = `${sample.lifetime.ifindex}:${sample.lifetime.wiphy}:${sample.lifetime.phyPath}`;
				seen.add(pair);
				if (sample.permanentMac) {
					cache.set(pair, sample.permanentMac);
				}
				const permanentMac =
					sample.permanentMac ??
					(sample.macReadFailed ? cache.get(pair) : undefined);
				samples.set(ifname, { ...sample, permanentMac });
				const path = sample.lifetime.phyPath;
				if (!ifname.startsWith("clap-")) {
					interfacesByPhy.set(path, (interfacesByPhy.get(path) ?? 0) + 1);
					if (sample.devicePath) {
						pathByPhy.set(path, sample.devicePath);
						const phys =
							devicePaths.get(sample.devicePath) ?? new Set<string>();
						phys.add(path);
						devicePaths.set(sample.devicePath, phys);
					}
				}
				if (permanentMac) {
					const paths = macPaths.get(permanentMac) ?? new Set<string>();
					paths.add(path);
					macPaths.set(permanentMac, paths);
				}
			} else {
				samples.set(ifname, undefined);
			}
		}
		if (signal?.aborted || generation < this.publishedSequence) return;
		for (const pair of cache.keys()) {
			if (!seen.has(pair)) cache.delete(pair);
		}

		const compositeMacs = new Set<MacAddress>();
		for (const [mac, phys] of macPaths) {
			if (phys.size > 1) this.sameAddressCollisions.add(mac);
			if (
				phys.size > 1 &&
				[...phys].every((phy) => {
					const port = pathByPhy.get(phy);
					return (
						interfacesByPhy.get(phy) === 1 &&
						port !== undefined &&
						devicePaths.get(port)?.size === 1
					);
				})
			)
				compositeMacs.add(mac);
		}
		const uncertain = [...samples.values()].some(
			(other) => other === undefined,
		);
		const rows = new Map<string, RadioIdentity>();
		for (const device of devices) {
			const row =
				device.row ??
				(generation === this.sequence
					? this.observedRows.get(device.ifname)
					: undefined);
			const sample = samples.get(device.ifname);
			const mac = sample?.permanentMac;
			const twins = mac !== undefined && (macPaths.get(mac)?.size ?? 0) > 1;
			const compositePort =
				mac && sample && compositeMacs.has(mac)
					? pathByPhy.get(sample.lifetime.phyPath)
					: undefined;
			const shared =
				// A still-listed uncertain witness cannot establish MAC uniqueness.
				uncertain ||
				(twins && !compositePort) ||
				(sample !== undefined &&
					(interfacesByPhy.get(sample.lifetime.phyPath) ?? 0) > 1);
			const classification = !sample
				? "unverified"
				: !mac || shared
					? "limited"
					: "verified";
			const degradedReason =
				(device.degradedReason === "permanent-mac-unresolved"
					? undefined
					: device.degradedReason) ??
				(classification === "limited" || classification === "unverified"
					? "permanent-mac-unresolved"
					: undefined);
			const previous = [...this.snapshot.rows.values()].find((row) =>
				sameRadioLifetime(row.lifetime, sample?.lifetime),
			);
			let key =
				classification === "verified" && mac
					? compositePort
						? `${mac}@${compositePort}`
						: mac
					: classification === "limited" && sample
						? `limited:${sample.lifetime.ifindex}:${sample.lifetime.wiphy}`
						: `degraded:${device.ifname}`;
			// A not-ready row can retain a key only with its predecessor's witness.
			if (
				(degradedReason === "unavailable" ||
					degradedReason === "operational-mac-missing") &&
				previous?.key !== key
			) {
				key = `degraded:${device.ifname}`;
			}
			const unchanged =
				previous !== undefined &&
				(previous.key === key ||
					(classification === "limited" &&
						previous.ifname !== device.ifname)) &&
				previous.classification === classification &&
				previous.permanentMac === mac &&
				(classification !== "verified" ||
					previous.devicePath ===
						(sample?.devicePath &&
						devicePaths.get(sample.devicePath)?.size === 1
							? sample.devicePath
							: undefined)) &&
				previous.degradedReason === degradedReason;
			let association: Pick<RadioIdentity, "row" | "observation"> = {};
			if (row) {
				association = { row, observation: generation };
			} else if (
				unchanged &&
				previous.ifname === device.ifname &&
				previous.row &&
				previous.observation !== undefined
			) {
				// Preserve exact operation ownership for this proven lifetime without making the old association fresh admission evidence.
				association = { row: previous.row, observation: previous.observation };
			}
			rows.set(device.ifname, {
				ifname: device.ifname,
				key,
				lifetime: sample?.lifetime,
				permanentMac: mac,
				...(sample?.devicePath && devicePaths.get(sample.devicePath)?.size === 1
					? { devicePath: sample.devicePath }
					: {}),
				classification,
				degradedReason,
				incarnation: unchanged ? previous.incarnation : crypto.randomUUID(),
				...association,
			});
		}
		this.permanentMacByLifetime = cache;
		this.publishedSequence = generation;
		this.sampledTopologyGeneration = topologyGeneration;
		this.project(rows);
	}

	markUnavailable(ifname: string): void {
		const row = this.snapshot.rows.get(ifname);
		if (!row || row.degradedReason === "unavailable") return;
		this.publishedSequence = this.captureObservation();
		const rows = new Map(this.snapshot.rows);
		rows.set(ifname, {
			...row,
			degradedReason: "unavailable",
			incarnation: crypto.randomUUID(),
		});
		this.project(rows);
	}

	private project(rows: ReadonlyMap<string, RadioIdentity>): void {
		const changed: string[] = [];
		for (const [ifname, row] of rows) {
			const previous = this.snapshot.rows.get(ifname);
			if (
				row.incarnation !== previous?.incarnation ||
				row.degradedReason !== previous.degradedReason
			) {
				changed.push(ifname);
			}
		}
		for (const ifname of this.snapshot.rows.keys()) {
			if (!rows.has(ifname)) changed.push(ifname);
		}
		this.snapshot = { rows, changed };
	}
}

export const wifiRadioIdentity = new WifiRadioIdentityProducer(
	radioIdentityReaders,
);
