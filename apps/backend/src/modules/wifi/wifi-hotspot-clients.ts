/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  Who is actually joined to the hotspot, read from the AP interface itself.

  THE RULE, and it is `wifi-capabilities.ts`'s rule applied to a different
  question: nothing here is inferred. A client is on this list because the
  kernel's own `iw dev <ifname> station dump` named its MAC on the interface the
  hotspot is broadcasting from — never because a DHCP lease exists, never
  because an ARP entry does, and never because NetworkManager counts something.
  A lease outlives an association and an ARP entry outlives both, so either
  would report a phone that walked out of the building ten minutes ago as
  connected.

  THE INTERFACE IS THE AP'S OWN, and that is load-bearing rather than obvious.
  A board can hold a station leg and an AP leg on ONE wiphy (see
  `staApCombo`), so asking the wrong netdev returns the OTHER leg's peers — on a
  station interface `station dump` lists the access point the board is joined
  TO, which would render the operator's own upstream router as a "client" of
  their hotspot. The caller passes the AP interface and nothing here guesses one.

  Four things about the shape of this data, each with its own guard:

  1. ZERO CLIENTS IS A READING, NOT A GAP. An AP nobody has joined prints
     nothing at all, so empty output is a first-class SUCCESS — the same rule
     `parseIwPhyCapabilities` states for a board with no Wi-Fi hardware. It
     reaches the wire as an explicit `count: 0`, never as an omitted block:
     "nobody is connected" and "we never asked" are different facts and the
     operator surface renders them differently.
  2. AN UNREAD INTERFACE PUBLISHES NOTHING. Until the first successful read the
     cache has no entry and the wire OMITS the block entirely, so a freshly
     started AP never claims an authoritative zero it has not measured.
  3. EVERY FIELD EXCEPT THE MAC IS OPTIONAL, and absence renders as absence. A
     station that has not yet reported a bitrate has no rate, not a zero — a
     zero would read as a stalled client.
  4. THE ROSTER IS CAPPED. `stations` is a bounded window
     ({@link HOTSPOT_CLIENTS_ROW_CAP}) while `count` stays the TRUE total, so a
     pathological AP cannot put an unbounded array on a 5 s broadcast. Same
     shape, same reason, as the SMS inbox's `SMS_INBOX_CAP`.

  The parser is NAMED and fails LOUD (S2): drifted output yields a typed
  `ParseError` rather than a partial roster that flows onward as if it had been
  measured. The spawn is BOUNDED (S1) by routing through `regdomain.ts`'s
  {@link runIw}, which is the ONE `iw` invocation path — so this module adds no
  second seam a test could miss, and `setRegdomainRunner` still covers the
  binary exactly once.
*/

import {
	HOTSPOT_CLIENTS_ROW_CAP,
	type HotspotClient,
	type HotspotClients,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import { runIw } from "./regdomain.ts";

export type { HotspotClient, HotspotClients };
export { HOTSPOT_CLIENTS_ROW_CAP };

// ─── pure parsing: `iw dev <ifname> station dump` ────────────────────────────

/**
 * `Station 8c:85:90:1a:2b:3c (on wlan0)`. The MAC is matched as a strict
 * colon-separated hex sextet: a header carrying anything else is drift, and
 * accepting it would put a value on the wire that names no device.
 */
const STATION_HEADER_RE = /^Station\s+((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\b/;
/** Any `Station ...` line, so a header we could NOT read is still detected. */
const STATION_ANY_RE = /^Station\b/;

/**
 * `signal:  	-42 [-45, -48] dBm` — the FIRST number is the combined value and
 * the bracketed list is per-chain. Anchoring on `signal:` (colon immediately
 * after the word) is what keeps `signal avg:` out of it; a looser test would
 * overwrite the reading with its own running average.
 */
const SIGNAL_RE = /^signal:\s*(-?\d+)/;
/** `tx bitrate:\t72.2 MBit/s MCS 7 short GI` — the decimal is optional. */
const TX_BITRATE_RE = /^tx bitrate:\s*(\d+(?:\.\d+)?)\s*MBit\/s/;
const RX_BITRATE_RE = /^rx bitrate:\s*(\d+(?:\.\d+)?)\s*MBit\/s/;

/**
 * Parse an `iw dev <ifname> station dump` into the joined-client roster.
 *
 * EMPTY output is SUCCESS with zero stations — an access point nobody has
 * joined prints nothing, and that is a measurement rather than a failure.
 * Non-empty output carrying no `Station` line at all, and a `Station` line
 * whose address is not a MAC, are both DRIFT and fail loud.
 */
export function parseIwStationDump(
	output: string,
): ParseResult<HotspotClient[]> {
	const stations: HotspotClient[] = [];
	if (output.trim() === "") return parseOk(stations);

	let current: { mac: string; fields: Partial<HotspotClient> } | undefined;
	let sawStation = false;

	const commit = () => {
		if (current === undefined) return;
		stations.push({ mac: current.mac, ...current.fields });
		current = undefined;
	};

	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;

		if (STATION_ANY_RE.test(line)) {
			const header = STATION_HEADER_RE.exec(line);
			if (!header?.[1]) {
				return parseFail(
					"parseIwStationDump",
					"a `Station` header carried no MAC address",
					output,
				);
			}
			commit();
			sawStation = true;
			// Lowercased so two reads of one device can never differ by case; the
			// kernel already prints lowercase, so this changes nothing it emits.
			current = { mac: header[1].toLowerCase(), fields: {} };
			continue;
		}

		if (current === undefined) continue;

		const signal = SIGNAL_RE.exec(line);
		if (signal?.[1]) {
			current.fields.signal_dbm = Number(signal[1]);
			continue;
		}
		const tx = TX_BITRATE_RE.exec(line);
		if (tx?.[1]) {
			const value = Number(tx[1]);
			// A zero-rate station has not negotiated yet; publishing 0 would read
			// as a measured stall, so it is left absent.
			if (value > 0) current.fields.tx_bitrate_mbps = value;
			continue;
		}
		const rx = RX_BITRATE_RE.exec(line);
		if (rx?.[1]) {
			const value = Number(rx[1]);
			if (value > 0) current.fields.rx_bitrate_mbps = value;
		}
	}
	commit();

	if (!sawStation) {
		return parseFail(
			"parseIwStationDump",
			"no `Station <mac>` line in a non-empty station dump",
			output,
		);
	}

	return parseOk(stations);
}

/**
 * The wire block for a parsed roster: the TRUE total plus a bounded window of
 * rows. Kept pure and exported so the acceptance test and the wire builder read
 * the same rule.
 */
export function buildHotspotClients(
	stations: readonly HotspotClient[],
): HotspotClients {
	return {
		count: stations.length,
		stations: stations.slice(0, HOTSPOT_CLIENTS_ROW_CAP).map((s) => ({ ...s })),
	};
}

// ─── effectful surface (injectable) ──────────────────────────────────────────

/**
 * How long a roster is served before the next ask re-reads it. Deliberately
 * short: unlike a wiphy's bands, this changes whenever somebody walks into or
 * out of range, and the operator is watching it precisely to see that happen.
 */
export const HOTSPOT_CLIENTS_TTL_MS = 5_000;

export type HotspotClientsDeps = {
	readonly runIw: (args: string[]) => Promise<string>;
	readonly now: () => number;
};

const defaultDeps: HotspotClientsDeps = {
	runIw: (args) => runIw(args),
	now: () => getms(),
};

let deps: HotspotClientsDeps = defaultDeps;

type ClientsCache = {
	clients: HotspotClients;
	readAtMs: number;
};

const cache = new Map<string, ClientsCache>();
const inFlight = new Map<string, Promise<void>>();
/** AP interfaces the wire builder has asked about, so a stale read can re-poke. */
let lastApIfnames: readonly string[] = [];

/** Test seam — mirrors `setWifiCapabilityDepsForTest` / `setRegdomainRunner`. */
export function setHotspotClientsDepsForTest(
	next: Partial<HotspotClientsDeps> | null,
): void {
	deps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

/** Test seam: drop every cached roster and restore the real runner. */
export function resetHotspotClientsForTest(): void {
	cache.clear();
	inFlight.clear();
	lastApIfnames = [];
	deps = defaultDeps;
}

async function readOne(ifname: string): Promise<void> {
	let dump: string;
	try {
		dump = await deps.runIw([
			"dev",
			argMatch(ID_RE, ifname),
			"station",
			"dump",
		]);
	} catch (err) {
		// A statement about the READ, not about the clients. The previous roster
		// stands — the same split `wifi-capabilities.ts` draws between a spawn
		// failure and a parse failure.
		logger.debug(`hotspot clients: ${ifname} station dump failed: ${err}`);
		return;
	}

	const parsed = parseIwStationDump(dump);
	if (!parsed.ok) {
		logParseError(parsed);
		// The shape we knew how to read is gone, so we can no longer vouch for
		// the roster we published from it. Dropping the entry omits the block
		// rather than serving a stale claim under an unreadable shape.
		cache.delete(ifname);
		return;
	}

	cache.set(ifname, {
		clients: buildHotspotClients(parsed.value),
		readAtMs: deps.now(),
	});
}

/**
 * Re-read the joined-client roster for every AP interface.
 *
 * Single-flight PER INTERFACE (two APs are independent reads) and never throws:
 * this runs behind a broadcast, and a failed read must cost a roster rather
 * than the whole Wi-Fi status.
 */
export async function refreshHotspotClients(
	apIfnames: readonly string[],
	opts?: { force?: boolean },
): Promise<void> {
	lastApIfnames = [...apIfnames];
	// A dev host has no AP and no `iw`; the mock branch of the wire builder
	// serves its own roster, so spawning here would be a parallel mechanism.
	if (shouldUseMocks()) return;

	// An interface that stopped being an AP stops being described.
	for (const ifname of [...cache.keys()]) {
		if (!apIfnames.includes(ifname)) cache.delete(ifname);
	}

	const nowMs = deps.now();
	const pending: Array<Promise<void>> = [];
	for (const ifname of apIfnames) {
		const entry = cache.get(ifname);
		if (
			opts?.force !== true &&
			entry !== undefined &&
			nowMs - entry.readAtMs < HOTSPOT_CLIENTS_TTL_MS
		) {
			continue;
		}
		const existing = inFlight.get(ifname);
		if (existing !== undefined) {
			pending.push(existing);
			continue;
		}
		const run = readOne(ifname)
			.catch((err) => {
				logger.debug(`hotspot clients: refresh failed for ${ifname}: ${err}`);
			})
			.finally(() => {
				inFlight.delete(ifname);
			});
		inFlight.set(ifname, run);
		pending.push(run);
	}

	await Promise.all(pending);
}

/**
 * The roster for ONE AP interface, or `undefined` when it has never been read.
 *
 * Synchronous because the wire builder is (`policy-route-check.ts` precedent).
 * A stale entry schedules the next read in the background and serves what it
 * has, so a broadcast is never blocked on a spawn — and `undefined` reaches the
 * wire as an OMITTED block, which the UI reads as "not measured" rather than as
 * an authoritative "nobody is connected".
 */
export function getHotspotClientsForInterface(
	ifname: string,
): HotspotClients | undefined {
	if (!lastApIfnames.includes(ifname)) {
		lastApIfnames = [...new Set([...lastApIfnames, ifname])];
	}
	const entry = cache.get(ifname);
	if (
		entry === undefined ||
		deps.now() - entry.readAtMs >= HOTSPOT_CLIENTS_TTL_MS
	) {
		void refreshHotspotClients(lastApIfnames);
	}
	return entry?.clients;
}
