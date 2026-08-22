/**
 * The render rule for the hotspot's joined-client roster — pure, rune-free.
 *
 * Every row is a station the DEVICE's own `iw dev <ifname> station dump` named
 * on the AP interface. Nothing here infers a client from a DHCP lease or an ARP
 * entry, both of which outlive an association and would list a phone that left
 * the building as connected.
 *
 * THE THREE STATES ARE GENUINELY THREE, and collapsing any pair is the bug:
 *
 *   | Wire                    | Renders                                        |
 *   |-------------------------|------------------------------------------------|
 *   | `clients` absent        | ZERO nodes — the device never read it           |
 *   | `{count: 0}`            | a calm "nobody is connected" line               |
 *   | `{count: n, stations}`  | the count plus one row per station              |
 *
 * The first two are the pair that matters: an older backend, and an AP whose
 * first read has not landed, both send nothing — and rendering that as "0
 * devices connected" asserts a measurement the device never made. Absence says
 * nothing; a measured zero is a reading and is worth showing.
 */
import type { HotspotClients, HotspotConfig } from "@ceraui/rpc/schemas";

import type { SignalCategory } from "$lib/helpers/signal";

export interface HotspotClientRow {
	/** The station's hardware address, rendered verbatim as a diagnostic tag. */
	readonly mac: string;
	readonly signalDbm?: number;
	/** Absent exactly when `signalDbm` is — colour never outlives its reading. */
	readonly signalCategory?: SignalCategory;
	readonly txMbps?: number;
	readonly rxMbps?: number;
}

export interface HotspotClientsView {
	/** The TRUE number of joined stations, which can exceed `rows.length`. */
	readonly count: number;
	readonly rows: readonly HotspotClientRow[];
	/** True when the device reported more stations than it sent rows for. */
	readonly capped: boolean;
}

/**
 * Signal tier for a station's RSSI.
 *
 * These thresholds are dBm, and that is why this does NOT call
 * `getSignalCategory`: that function's scale is a 0-100 PERCENT (nmcli's
 * quality figure), so handing it -47 would bucket a strong client as `weak` and
 * paint a healthy row red. The two share the COLOUR RAMP via `SignalCategory`
 * and deliberately not the scale.
 */
export function hotspotClientSignalCategory(dbm: number): SignalCategory {
	if (dbm >= -50) return "excellent";
	if (dbm >= -60) return "good";
	if (dbm >= -70) return "fair";
	return "weak";
}

/**
 * The roster to render, or `undefined` when the section must show nothing.
 *
 * `undefined` is the regression lock: a backend that predates the station-dump
 * read sends no `clients` block, and the hotspot section then renders exactly
 * what it rendered before this existed.
 */
export function deriveHotspotClientsView(
	hotspot: HotspotConfig | undefined,
): HotspotClientsView | undefined {
	const clients: HotspotClients | undefined = hotspot?.clients;
	if (!clients) return undefined;

	const rows: HotspotClientRow[] = clients.stations.map((station) => ({
		mac: station.mac,
		...(typeof station.signal_dbm === "number"
			? {
					signalDbm: station.signal_dbm,
					signalCategory: hotspotClientSignalCategory(station.signal_dbm),
				}
			: {}),
		...(typeof station.tx_bitrate_mbps === "number"
			? { txMbps: station.tx_bitrate_mbps }
			: {}),
		...(typeof station.rx_bitrate_mbps === "number"
			? { rxMbps: station.rx_bitrate_mbps }
			: {}),
	}));

	return { count: clients.count, rows, capped: clients.count > rows.length };
}

/**
 * The row's rate cell: `144 / 130`, or just the half that was reported.
 *
 * A station that has negotiated only one direction renders ONE figure with no
 * orphan separator — a bare `144 /` reads as a dropped value rather than as an
 * unreported one. Neither reported yields `undefined`, so the cell is omitted
 * entirely instead of showing a dash that looks like a measured zero.
 *
 * Whole megabits: this is a glanceable rate, and `144.4` invites a precision the
 * reading does not carry.
 */
export function formatClientRatePair(
	txMbps: number | undefined,
	rxMbps: number | undefined,
): string | undefined {
	const parts = [txMbps, rxMbps]
		.filter((v): v is number => typeof v === "number")
		.map((v) => String(Math.round(v)));
	return parts.length === 0 ? undefined : parts.join(" / ");
}
