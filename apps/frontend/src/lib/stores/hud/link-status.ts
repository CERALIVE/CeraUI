/**
 * HUD link-status derivation — pure, rune-free.
 *
 * Builds the ordered {@link LinkSignal} list the HUD renders from the raw wifi,
 * modem, and ethernet telemetry, joining throughput/enabled from `netif` by
 * ifname. Never throws on missing/partial/null inputs.
 */

import type {
	Modem,
	ModemList,
	NetifEntry,
	NetifMessage,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { isLoopbackIpv4 } from "$lib/helpers/ip-classification";
import {
	bitsPerSecondToKbps,
	convertBytesToKbids,
} from "$lib/helpers/network-speed";
import { modemSignal } from "$lib/helpers/signal";
import type { LinkSignal } from "$lib/types/hud";
import { MAX_LINKS } from "./constants";

/**
 * Map a modem's backend `status.connection` + `no_sim` flag onto the HUD's
 * simplified {@link LinkSignal.connectionState}. `no_sim` wins over everything
 * (a SIM-less modem can never be connected); otherwise `connected`/`scanning`
 * pass through and every other backend state (failed/registered/connecting or
 * a missing status) collapses to `disconnected`.
 */
export function modemConnectionState(
	modem: Modem,
): LinkSignal["connectionState"] {
	if (modem.no_sim === true) return "no_sim";
	switch (modem.status?.connection) {
		case "connected":
			return "connected";
		case "scanning":
			return "scanning";
		default:
			return "disconnected";
	}
}

/**
 * Is this link present-but-not-carrying — kept out of the bond by a DEVICE
 * condition rather than by the operator?
 *
 * True when the interface has no `netif` entry at all (a modem that never
 * attached, a radio with no lease), holds no address, or carries a netif error
 * (the dup-IP HiLink pair).
 */
export function isBondExcluded(entry: NetifEntry | undefined): boolean {
	if (!entry) return true;
	if (entry.error !== undefined && entry.error !== "") return true;
	if (!entry.ip) return true;
	return false;
}

/**
 * Does this interface actually carry bonded traffic right now?
 *
 * This is the frontend mirror of the backend's own bond-membership rule —
 * `genSrtlaIpList()` (`modules/streaming/srtla.ts`) writes the srtla source-IP
 * list from exactly the `netif` entries that are `enabled` and hold an `ip`, so
 * an interface satisfying that pair IS a bonded link and one that does not is
 * not. Both halves of the exclusion are folded here: an operator's `enabled:
 * false` (a statement of intent) and a device condition
 * ({@link isBondExcluded}) both mean the link carries nothing.
 */
export function isBondMember(entry: NetifEntry | undefined): boolean {
	return entry?.enabled === true && !isBondExcluded(entry);
}

/** A bond snapshot: the links that carry traffic, and how many do not. */
export interface BondSnapshot {
	links: LinkSignal[];
	/**
	 * Interfaces the device knows about that are NOT in the bond. The panel
	 * states this count so removing their rows never hides that they exist; the
	 * REASON stays owned by the per-device row that can actually explain it.
	 */
	unbondedCount: number;
}

/**
 * Build the ordered {@link LinkSignal} list from wifi, modem, and remaining
 * `netif` data, keeping ONLY the interfaces that carry bonded traffic
 * ({@link isBondMember}).
 *
 * Ordering is stable: wifi interfaces first (so wifi takes `linkIndex` 0 when
 * present), then modems, then every other `netif` row in record order. The list
 * is capped at {@link MAX_LINKS} and `linkIndex` is the 0-based position.
 *
 * `isStreaming` gates live throughput: identity, signal, and connectivity are
 * always derived, but per-link `throughputKbps` is zeroed when not streaming so
 * the HUD never persists a stale bitrate from the last session (Live-Data
 * Discipline, T6).
 */
export function buildBond(
	modems: ModemList | undefined,
	wifi: WifiStatus | undefined,
	netif: NetifMessage | undefined,
	modemsStale: boolean,
	wifiStale: boolean,
	fullyStale: boolean,
	staleIds: Set<string> = new Set(),
	isStreaming = true,
): BondSnapshot {
	const links: LinkSignal[] = [];
	const netifEntries = netif ?? {};
	// Every id a wifi/modem row already speaks for, so the sweep below cannot
	// render a second entry for the same interface.
	const claimed = new Set<string>();
	let unbondedCount = 0;

	const throughputFor = (id: string): number =>
		isStreaming ? convertBytesToKbids(netifEntries[id]?.tp ?? 0) : 0;
	const rateFor = (id: string, direction: "tx" | "rx"): number | null => {
		const bps =
			direction === "tx" ? netifEntries[id]?.tx_bps : netifEntries[id]?.rx_bps;
		return bps === undefined ? null : bitsPerSecondToKbps(bps);
	};
	const ratesFor = (id: string) => ({
		rateTxKbps: rateFor(id, "tx"),
		rateRxKbps: rateFor(id, "rx"),
	});

	for (const [key, iface] of Object.entries(wifi ?? {})) {
		// Key by the kernel interface name, not the wifi record key: the backend
		// may key the record by a radio/device id that differs from ifname, which
		// is what netif and the WiFi view both join on (mirrors the modem path).
		const id = iface.ifname || key;
		claimed.add(id);
		if (!isBondMember(netifEntries[id])) {
			unbondedCount += 1;
			continue;
		}
		const active = iface.available?.find((network) => network.active);
		const isConnected = Boolean(active);
		links.push({
			id,
			type: "wifi",
			linkIndex: 0,
			signal: active && Number.isFinite(active.signal) ? active.signal : null,
			label: active?.ssid || "WiFi",
			isConnected,
			isStale: wifiStale || fullyStale || staleIds.has(id),
			throughputKbps: throughputFor(id),
			...ratesFor(id),
			enabled: true,
			connectionState: isConnected ? "connected" : "disconnected",
		});
	}

	for (const [key, modem] of Object.entries(modems ?? {})) {
		const id = modem.ifname || key;
		claimed.add(id);
		if (!isBondMember(netifEntries[id])) {
			unbondedCount += 1;
			continue;
		}
		const connectionState = modemConnectionState(modem);
		links.push({
			id,
			type: "modem",
			linkIndex: 0,
			signal: modemSignal(modem),
			label: modem.name || modem.status?.network || "Modem",
			isConnected: connectionState === "connected",
			isStale: modemsStale || fullyStale || staleIds.has(id),
			throughputKbps: throughputFor(id),
			...ratesFor(id),
			enabled: true,
			connectionState,
		});
	}

	// Every remaining interface, matched on bond membership rather than on an
	// `eth*` name. A name prefix cannot see this bench's router-mode cellular
	// dongles (`enx344b50000000` bonds; its HiLink twin falls back to `eth1`),
	// nor an isolated dongle's `dg<N>h` veth — all of which the backend bonds.
	for (const [ifname, entry] of Object.entries(netifEntries)) {
		if (claimed.has(ifname)) continue;
		// Loopback is not an uplink in either state, so it is neither rendered nor
		// counted. Keyed on the ADDRESS, never the name — the backend already drops
		// `lo` (`network-interfaces.ts`), so this is belt-and-braces, not the rule.
		if (isLoopbackIpv4(entry.ip)) continue;
		if (!isBondMember(entry)) {
			unbondedCount += 1;
			continue;
		}
		links.push({
			id: ifname,
			type: "ethernet",
			linkIndex: 0,
			signal: null,
			label: ifname,
			isConnected: true,
			isStale: fullyStale || staleIds.has(ifname),
			throughputKbps: throughputFor(ifname),
			...ratesFor(ifname),
			enabled: true,
			connectionState: "connected",
		});
	}

	return {
		links: links
			.slice(0, MAX_LINKS)
			.map((link, index) => ({ ...link, linkIndex: index })),
		unbondedCount,
	};
}

/** The bond's carrying links alone — {@link buildBond} without the count. */
export function buildLinks(
	...args: Parameters<typeof buildBond>
): LinkSignal[] {
	return buildBond(...args).links;
}
