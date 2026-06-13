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
	NetifMessage,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { convertBytesToKbids } from "$lib/helpers/network-speed";
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
 * Build the ordered list of {@link LinkSignal} entries from wifi, modem, and
 * ethernet data. Throughput and `enabled` are joined from `netif` by `id`
 * (== ifname); ethernet links come from `netif` entries named `eth*` that are
 * enabled with an IP.
 *
 * Ordering is stable: wifi interfaces first (so wifi takes `linkIndex` 0 when
 * present), then modems, then ethernet in record order. The list is capped at
 * {@link MAX_LINKS} and `linkIndex` is the 0-based position.
 */
export function buildLinks(
	modems: ModemList | undefined,
	wifi: WifiStatus | undefined,
	netif: NetifMessage | undefined,
	modemsStale: boolean,
	wifiStale: boolean,
	fullyStale: boolean,
	staleIds: Set<string> = new Set(),
): LinkSignal[] {
	const links: LinkSignal[] = [];
	const netifEntries = netif ?? {};

	const throughputFor = (id: string): number =>
		convertBytesToKbids(netifEntries[id]?.tp ?? 0);
	const enabledFor = (id: string): boolean => netifEntries[id]?.enabled ?? true;

	for (const [key, iface] of Object.entries(wifi ?? {})) {
		// Key by the kernel interface name, not the wifi record key: the backend
		// may key the record by a radio/device id that differs from ifname, which
		// is what netif and the WiFi view both join on (mirrors the modem path).
		const id = iface.ifname || key;
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
			enabled: enabledFor(id),
			connectionState: isConnected ? "connected" : "disconnected",
		});
	}

	for (const [key, modem] of Object.entries(modems ?? {})) {
		const id = modem.ifname || key;
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
			enabled: enabledFor(id),
			connectionState,
		});
	}

	for (const [ifname, entry] of Object.entries(netifEntries)) {
		if (!ifname.startsWith("eth") || entry.enabled !== true || !entry.ip)
			continue;
		links.push({
			id: ifname,
			type: "ethernet",
			linkIndex: 0,
			signal: null,
			label: ifname,
			isConnected: true,
			isStale: fullyStale || staleIds.has(ifname),
			throughputKbps: convertBytesToKbids(entry.tp ?? 0),
			enabled: entry.enabled,
			connectionState: "connected",
		});
	}

	return links
		.slice(0, MAX_LINKS)
		.map((link, index) => ({ ...link, linkIndex: index }));
}
