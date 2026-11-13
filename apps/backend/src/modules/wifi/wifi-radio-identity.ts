import { realpath } from "node:fs/promises";
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
	readonly classification: "verified" | "limited" | "unverified";
	readonly degradedReason: WifiAdapterDegradedReason | undefined;
	readonly incarnation: string;
	readonly row?: BaseWifiInterface;
	readonly observation?: number;
};

export type RadioIdentityReaders = {
	readonly readText: (path: string) => Promise<string | undefined>;
	readonly realpath: (path: string) => Promise<string | undefined>;
};

let shadowFailures = 0;

export function recordWifiRadioShadowFailure(): void {
	shadowFailures++;
}

export function getWifiRadioShadowFailures(): number {
	return shadowFailures;
}

// These reads are observational. The existing resolver still owns every live key.
export const radioIdentityReaders: RadioIdentityReaders = {
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

function sameLifetime(
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
 * Observational lifetime evidence. Only the optional status token is projected;
 * this state never selects registry keys, credentials or activation targets.
 */
export class WifiRadioIdentityProducer {
	private permanentMacByLifetime = new Map<string, MacAddress>();
	private snapshot: RadioIdentityState = { rows: new Map(), changed: [] };
	private sequence = 0;
	private publishedSequence = 0;

	constructor(private readonly readers: RadioIdentityReaders) {}

	get state(): RadioIdentityState {
		return this.snapshot;
	}

	get publishedObservation(): number {
		return this.publishedSequence;
	}

	captureObservation(): number {
		return ++this.sequence;
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
		const macCounts = new Map<MacAddress, number>();
		// Finish classification before publishing any healthy identity edge.
		for (const { ifname } of devices) {
			const sample = await sampleRadio(ifname, this.readers, signal);
			if (signal?.aborted) return;
			if (sample) {
				const pair = `${sample.lifetime.ifindex}:${sample.lifetime.wiphy}`;
				seen.add(pair);
				if (sample.permanentMac) {
					cache.set(pair, sample.permanentMac);
				}
				const permanentMac =
					sample.permanentMac ??
					(sample.macReadFailed ? cache.get(pair) : undefined);
				samples.set(ifname, { ...sample, permanentMac });
				if (permanentMac) {
					macCounts.set(permanentMac, (macCounts.get(permanentMac) ?? 0) + 1);
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
			const sample = samples.get(device.ifname);
			const mac = sample?.permanentMac;
			const shared = mac !== undefined && (macCounts.get(mac) ?? 0) > 1;
			const classification = !sample
				? "unverified"
				: !mac || shared
					? "limited"
					: "verified";
			const degradedReason =
				device.degradedReason ??
				(classification === "limited" || classification === "unverified"
					? "permanent-mac-unresolved"
					: undefined);
			const previous = [...this.snapshot.rows.values()].find((row) =>
				sameLifetime(row.lifetime, sample?.lifetime),
			);
			let key =
				classification === "verified" && mac
					? mac
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
				classification,
				degradedReason,
				incarnation: unchanged ? previous.incarnation : crypto.randomUUID(),
				...(device.row ? { row: device.row, observation: generation } : {}),
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
