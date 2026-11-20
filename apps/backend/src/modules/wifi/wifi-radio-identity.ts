import { readdir, realpath } from "node:fs/promises";
import type { MacAddress } from "../network/network-manager.ts";
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

// The bracketed lifetime sample owns adapter identity.
export const radioIdentityReaders: RadioIdentityReaders & {
	readonly listInterfaces: () => Promise<string[] | undefined>;
} = {
	listInterfaces: () => readdir("/sys/class/net").catch(() => undefined),
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

/**
 * Coherent lifetime evidence selects registry keys before discovery publishes.
 */
export class WifiRadioIdentityProducer {
	private permanentMacByLifetime = new Map<string, MacAddress>();
	private snapshot: RadioIdentityState = { rows: new Map(), changed: [] };
	private sequence = 0;
	private publishedSequence = 0;
	// Discovery can publish rows before a capacity-deferred sample begins.
	private observedRows = new Map<string, BaseWifiInterface>();

	constructor(private readonly readers: RadioIdentityReaders) {}

	get state(): RadioIdentityState {
		return this.snapshot;
	}

	get publishedObservation(): number {
		return this.publishedSequence;
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

		const rows = new Map<string, RadioIdentity>();
		for (const device of devices) {
			const row =
				device.row ??
				(generation === this.sequence
					? this.observedRows.get(device.ifname)
					: undefined);
			const sample = samples.get(device.ifname);
			const mac = sample?.permanentMac;
			const shared =
				// A still-listed uncertain witness cannot establish MAC uniqueness.
				[...samples.values()].some((other) => other === undefined) ||
				(mac !== undefined && (macPaths.get(mac)?.size ?? 0) > 1) ||
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
					? mac
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
				previous.degradedReason === degradedReason;
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
				...(row ? { row, observation: generation } : {}),
			});
		}
		this.permanentMacByLifetime = cache;
		this.publishedSequence = generation;
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
