import { logger } from "../../helpers/logger.ts";
import { ID_RE } from "../../helpers/run.ts";
import type { MacAddress } from "../network/network-manager.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import type {
	RadioIdentityReaders,
	RadioLifetime,
} from "./wifi-radio-identity.ts";

const MAX_OUTSTANDING_READS = 4;
let outstanding = 0;
let reported = false;
const waiting = new Set<() => void>();

export function hasWifiRadioReadCapacity(): boolean {
	return outstanding < MAX_OUTSTANDING_READS;
}

export function deferWifiRadioRead(resume: () => void): () => void {
	waiting.add(resume);
	if (!reported) {
		reported = true;
		logger.warn(
			`Wi-Fi identity reads still held (${outstanding}); deferring sampling`,
		);
	}
	return () => {
		waiting.delete(resume);
	};
}

export async function readWifiRadio(
	read: () => Promise<string | undefined>,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	while (!hasWifiRadioReadCapacity()) {
		const available = Promise.withResolvers<void>();
		const resume = () => available.resolve();
		const cancel = deferWifiRadioRead(resume);
		signal?.addEventListener("abort", resume, { once: true });
		await available.promise;
		cancel();
		signal?.removeEventListener("abort", resume);
		if (signal?.aborted) return undefined;
	}
	outstanding++;
	try {
		return await read();
	} finally {
		outstanding--;
		reported = false;
		const ready = [...waiting];
		waiting.clear();
		for (const resume of ready) resume();
	}
}

export type RadioSample = {
	readonly lifetime: RadioLifetime;
	readonly permanentMac: MacAddress | undefined;
	readonly macReadFailed: boolean;
};

function index(raw: string | undefined, minimum: number): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

export async function sampleRadio(
	ifname: string,
	readers: RadioIdentityReaders,
	signal: AbortSignal | undefined,
): Promise<RadioSample | undefined> {
	if (signal?.aborted || !ID_RE.test(ifname)) return undefined;
	const readText = (path: string) =>
		readWifiRadio(() => readers.readText(path), signal);
	const readPath = (path: string) =>
		readWifiRadio(() => readers.realpath(path), signal);
	const net = `/sys/class/net/${ifname}`;
	const i1 = index(await readText(`${net}/ifindex`), 1);
	if (signal?.aborted) return undefined;
	const d1 = await readPath(`${net}/phy80211`);
	if (signal?.aborted || i1 === undefined || !d1) return undefined;
	const wiphy = index(await readText(`${d1}/index`), 0);
	if (signal?.aborted) return undefined;
	const rawMac = await readText(`${d1}/macaddress`);
	if (signal?.aborted) return undefined;
	const permanentMac = normalizeMacAddress(rawMac);
	const i2 = index(await readText(`${net}/ifindex`), 1);
	if (signal?.aborted) return undefined;
	const d2 = await readPath(`${net}/phy80211`);
	if (signal?.aborted || i1 !== i2 || d1 !== d2 || wiphy === undefined) {
		return undefined;
	}
	return {
		lifetime: { ifindex: i1, wiphy, phyPath: d1 },
		permanentMac,
		macReadFailed: rawMac === undefined,
	};
}
