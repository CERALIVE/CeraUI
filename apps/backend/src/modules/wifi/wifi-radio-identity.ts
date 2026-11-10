import { realpath } from "node:fs/promises";
import { ID_RE } from "../../helpers/run.ts";
import { type MacAddress, nmDeviceProp } from "../network/network-manager.ts";
import type { WifiAdapterDegradedReason } from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

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
	readonly path: string | undefined;
	readonly classification: "verified" | "composite" | "limited" | "unverified";
	readonly degradedReason: WifiAdapterDegradedReason | undefined;
	readonly incarnation: string;
};

export type RadioIdentityReaders = {
	readonly readText: (path: string) => Promise<string | undefined>;
	readonly realpath: (path: string) => Promise<string | undefined>;
	readonly readPath: (ifname: string) => Promise<string | undefined>;
};

// These reads are observational. The existing resolver still owns every live key.
export const radioIdentityReaders: RadioIdentityReaders = {
	readText: (path) =>
		Bun.file(path)
			.text()
			.catch(() => undefined),
	realpath: (path) => realpath(path).catch(() => undefined),
	readPath: async (ifname) => {
		const fields = await nmDeviceProp(ifname, "GENERAL.PATH");
		if (fields?.length === 2 && fields[1] === "") fields.pop();
		return fields?.length === 1 ? fields[0] : undefined;
	},
};

type RadioObservation = {
	readonly ifname: string;
	readonly degradedReason?: WifiAdapterDegradedReason;
};

type RadioSample = {
	readonly lifetime: RadioLifetime;
	readonly permanentMac: MacAddress | undefined;
	readonly macReadFailed: boolean;
	readonly path: string | undefined;
};

function index(raw: string | undefined, minimum: number): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

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

async function sampleRadio(
	ifname: string,
	readers: RadioIdentityReaders,
): Promise<RadioSample | undefined> {
	if (!ID_RE.test(ifname)) return undefined;
	const net = `/sys/class/net/${ifname}`;
	const i1 = index(await readers.readText(`${net}/ifindex`), 1);
	const d1 = await readers.realpath(`${net}/phy80211`);
	if (i1 === undefined || !d1) return undefined;
	const wiphy = index(await readers.readText(`${d1}/index`), 0);
	const rawMac = await readers.readText(`${d1}/macaddress`);
	const permanentMac = normalizeMacAddress(rawMac);
	// GENERAL.PATH is read unescaped by nmDeviceProp, inside the same bracket.
	const rawPath = await readers.readPath(ifname);
	const i2 = index(await readers.readText(`${net}/ifindex`), 1);
	const d2 = await readers.realpath(`${net}/phy80211`);
	if (i1 !== i2 || d1 !== d2 || wiphy === undefined) return undefined;
	const path =
		rawPath && !/[\s*?[\]!|&\\\p{Cc}]/u.test(rawPath) ? rawPath : undefined;
	return {
		lifetime: { ifindex: i1, wiphy, phyPath: d1 },
		permanentMac,
		macReadFailed: rawMac === undefined,
		path,
	};
}

export type RadioIdentityState = {
	readonly rows: ReadonlyMap<string, RadioIdentity>;
	readonly changed: readonly string[];
};

/**
 * Shadow-only lifetime evidence. Neither this state nor its diff feeds the
 * live registry, wire projection, credential store or activation handlers.
 */
export class WifiRadioIdentityProducer {
	private readonly permanentMacByLifetime = new Map<string, MacAddress>();
	private snapshot: RadioIdentityState = { rows: new Map(), changed: [] };

	constructor(private readonly readers: RadioIdentityReaders) {}

	get state(): RadioIdentityState {
		return this.snapshot;
	}

	async discover(devices: readonly RadioObservation[]): Promise<void> {
		const samples = new Map<string, RadioSample | undefined>();
		const seen = new Set<string>();
		const macCounts = new Map<MacAddress, number>();
		const pathCounts = new Map<string, number>();
		// Finish classification before publishing any healthy identity edge.
		for (const { ifname } of devices) {
			const sample = await sampleRadio(ifname, this.readers);
			if (sample) {
				const pair = `${sample.lifetime.ifindex}:${sample.lifetime.wiphy}`;
				seen.add(pair);
				if (sample.permanentMac) {
					this.permanentMacByLifetime.set(pair, sample.permanentMac);
				}
				const permanentMac =
					sample.permanentMac ??
					(sample.macReadFailed
						? this.permanentMacByLifetime.get(pair)
						: undefined);
				samples.set(ifname, { ...sample, permanentMac });
				if (permanentMac) {
					macCounts.set(permanentMac, (macCounts.get(permanentMac) ?? 0) + 1);
				}
				if (sample.path) {
					pathCounts.set(sample.path, (pathCounts.get(sample.path) ?? 0) + 1);
				}
			} else {
				samples.set(ifname, undefined);
			}
		}
		for (const pair of this.permanentMacByLifetime.keys()) {
			if (!seen.has(pair)) this.permanentMacByLifetime.delete(pair);
		}

		const rows = new Map<string, RadioIdentity>();
		for (const device of devices) {
			const sample = samples.get(device.ifname);
			const mac = sample?.permanentMac;
			const shared = mac !== undefined && (macCounts.get(mac) ?? 0) > 1;
			const path =
				sample?.path && pathCounts.get(sample.path) === 1
					? sample.path
					: undefined;
			const classification = !sample
				? "unverified"
				: !mac || (shared && !path)
					? "limited"
					: shared
						? "composite"
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
					: classification === "composite" && mac
						? `${mac}@${path}`
						: `degraded:${device.ifname}`;
			// A not-ready row can retain a key only with its predecessor's witness.
			if (device.degradedReason && previous?.key !== key) {
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
				path,
				classification,
				degradedReason,
				incarnation: unchanged ? previous.incarnation : crypto.randomUUID(),
			});
		}
		this.project(rows);
	}

	markUnavailable(ifname: string): void {
		const row = this.snapshot.rows.get(ifname);
		if (!row || row.degradedReason === "unavailable") return;
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
