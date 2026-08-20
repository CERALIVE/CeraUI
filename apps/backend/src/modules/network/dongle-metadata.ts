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
 * Reader for the router-dongle netns runtime metadata (schema v1).
 *
 * The device image's netns manager writes one file per claimed dongle at
 * `/run/ceralive/dongles/dongle<N>.json` (image-building-pipeline
 * `docs/dongle-netns-contract.md` §6.1). This module is CeraUI's INDEPENDENT
 * reader of that contract: the schema below is a MIRROR, not an import — Rule D
 * forbids reaching into a sibling checkout, and the contract itself states that
 * each repo carries its own reader and its own fixtures.
 *
 * Two producer-side conveniences are deliberately NOT depended on. The manager
 * emits a canonical one-key-per-line serialization so a shell can parse it with
 * `awk`; §6.3 states consumers must not rely on that form, so this reads it with
 * a real JSON parser and a schema. And the manager writes temp-file + rename, so
 * a partial file is never observed — but a malformed one still degrades rather
 * than throwing, because a fault here must never break the netif poll.
 *
 * Every rejection is silent to the caller and LOGGED ONCE per file+reason:
 * an unknown `version`, a malformed record, a record whose heartbeat has gone
 * stale, and two records claiming the same host veth (ambiguous — neither is
 * trusted, mirroring the duplicate-VID:PID refusal in the certification seam).
 */

import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

/** Directory the netns manager writes its per-slot metadata into. */
export const DONGLE_METADATA_DIR = "/run/ceralive/dongles";

/** Contract §2.1: slots are `0..7`, so at most eight files can exist. */
export const DONGLE_SLOT_COUNT = 8;

/** Contract §6.1: the supervisor refreshes `updated_at_ms` every 30 s. */
export const DONGLE_HEARTBEAT_MS = 30_000;

/**
 * Contract §6.1: a record is stale only past THREE missed heartbeats. One
 * delayed heartbeat under load must never demote a healthy streaming link.
 */
export const DONGLE_STALE_MS = 90_000;

/** Host-side veth of a claimed dongle: `dg<N>h` (contract §2.1). */
const DONGLE_VETH_RE = /^dg(\d+)h$/;

export const dongleStateSchema = z.enum(["acquiring", "up", "down"]);
export type DongleState = z.infer<typeof dongleStateSchema>;

/**
 * The v1 record, mirroring contract §6.1's CLOSED field set.
 *
 * `driver` is typed as a non-empty string rather than the contract's
 * three-value enum on purpose: §6.1 permits additive-optional evolution within
 * v1 and a reader MUST ignore what it does not know, so rejecting a record for
 * naming a fourth USB-ethernet driver would drop a working dongle over a field
 * this consumer never reads.
 */
export const dongleMetadataSchema = z.object({
	version: z.literal(1),
	slot: z
		.number()
		.int()
		.min(0)
		.max(DONGLE_SLOT_COUNT - 1),
	ifname: z.string().min(1),
	usb_path: z.string().min(1),
	mac: z.string().min(1),
	driver: z.string().min(1),
	inner_ip: z.string().nullable(),
	inner_gateway: z.string().nullable(),
	veth_host: z.string().regex(DONGLE_VETH_RE),
	veth_host_ip: z.string().min(1),
	state: dongleStateSchema,
	updated_at_ms: z.number().int(),
	lease_refresh_ms: z.number().int(),
});
export type DongleMetadata = z.infer<typeof dongleMetadataSchema>;

/** The subset of a record that reaches the `netif` wire projection. */
export type DongleMarker = { slot: number; state: DongleState };

export type DongleMetadataDeps = {
	/** Absolute paths of the candidate metadata files, in any order. */
	listFiles: () => Promise<string[]>;
	/** File contents, or `undefined` when the file is gone/unreadable. */
	readFile: (path: string) => Promise<string | undefined>;
	now: () => number;
};

// A dev host has no netns manager, so the fixtures are served as file CONTENT
// at the deps seam rather than as parsed records past it. That keeps the schema,
// staleness and ambiguity rules below on the dev path — the reader cannot tell a
// fixture from a claim — and it feeds BOTH consumers (the netif marker and the
// modems row) from one place. Imports are lazy: the mock graph stays off this
// module's production load path.
async function defaultListFiles(): Promise<string[]> {
	if (shouldUseMocks()) {
		const { listMockDongleFiles } = await import(
			"../../mocks/providers/cellular.ts"
		);
		return listMockDongleFiles();
	}
	const paths: string[] = [];
	for (let slot = 0; slot < DONGLE_SLOT_COUNT; slot++) {
		const path = `${DONGLE_METADATA_DIR}/dongle${slot}.json`;
		if (await Bun.file(path).exists()) paths.push(path);
	}
	return paths;
}

async function defaultReadFile(path: string): Promise<string | undefined> {
	if (shouldUseMocks()) {
		const { readMockDongleFile } = await import(
			"../../mocks/providers/cellular.ts"
		);
		return readMockDongleFile(path);
	}
	try {
		return await Bun.file(path).text();
	} catch {
		return undefined;
	}
}

export const defaultDongleMetadataDeps: DongleMetadataDeps = {
	listFiles: defaultListFiles,
	readFile: defaultReadFile,
	now: () => Date.now(),
};

// One log line per (file, reason). The key is cleared once that file parses
// cleanly again, so a dongle that recovers and later re-faults is reported
// again instead of being silently swallowed for the process lifetime.
const reportedRejections = new Set<string>();

function reportRejection(path: string, reason: string, detail?: unknown): void {
	const key = `${path}:${reason}`;
	if (reportedRejections.has(key)) return;
	reportedRejections.add(key);
	logger.warn(`dongle metadata ignored (${reason})`, { path, detail });
}

function clearRejections(path: string): void {
	for (const key of [...reportedRejections]) {
		if (key.startsWith(`${path}:`)) reportedRejections.delete(key);
	}
}

function parseRecord(
	path: string,
	raw: string,
	now: number,
): DongleMetadata | undefined {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		reportRejection(path, "malformed-json", String(err));
		return undefined;
	}

	const version = (json as { version?: unknown } | null)?.version;
	if (version !== 1) {
		reportRejection(path, "unsupported-version", version);
		return undefined;
	}

	const parsed = dongleMetadataSchema.safeParse(json);
	if (!parsed.success) {
		reportRejection(path, "schema-mismatch", parsed.error.issues);
		return undefined;
	}

	if (now - parsed.data.updated_at_ms > DONGLE_STALE_MS) {
		reportRejection(path, "stale-heartbeat", parsed.data.updated_at_ms);
		return undefined;
	}

	clearRejections(path);
	return parsed.data;
}

/**
 * Read every currently-published record, keyed by host veth name.
 *
 * NEVER throws and NEVER partially fails the caller: an unreadable directory,
 * an unreadable file, or a rejected record yields a smaller map.
 */
export async function readDongleMetadata(
	deps: DongleMetadataDeps = defaultDongleMetadataDeps,
): Promise<Map<string, DongleMetadata>> {
	let paths: string[];
	try {
		paths = await deps.listFiles();
	} catch (err) {
		logger.debug("dongle metadata directory unreadable", { err });
		return new Map();
	}

	const now = deps.now();
	const byVeth = new Map<string, DongleMetadata>();
	const ambiguous = new Set<string>();

	for (const path of [...paths].sort()) {
		let raw: string | undefined;
		try {
			raw = await deps.readFile(path);
		} catch (err) {
			reportRejection(path, "unreadable", String(err));
			continue;
		}
		if (raw === undefined) continue;

		const record = parseRecord(path, raw, now);
		if (!record) continue;

		// Two records claiming one host veth cannot both be true, and picking
		// either would attribute one dongle's state to another. Refuse both.
		if (byVeth.has(record.veth_host)) {
			reportRejection(path, "ambiguous-veth", record.veth_host);
			ambiguous.add(record.veth_host);
			continue;
		}
		byVeth.set(record.veth_host, record);
	}

	for (const veth of ambiguous) byVeth.delete(veth);
	return byVeth;
}

// ─── Cached snapshot consumed by the (synchronous) netif payload assembly ────

let records: Map<string, DongleMetadata> = new Map();

function snapshotKey(current: Map<string, DongleMetadata>): string {
	return [...current.entries()]
		.map(([veth, record]) => `${veth}:${record.slot}:${record.state}`)
		.sort()
		.join("|");
}

/**
 * Refresh the cached snapshot on the netif cadence.
 *
 * @returns whether the OBSERVABLE state (veth → slot/state) changed, so the
 *   caller can rebroadcast on a real edge instead of every tick.
 */
export async function refreshDongleMetadata(
	deps: DongleMetadataDeps = defaultDongleMetadataDeps,
): Promise<boolean> {
	const before = snapshotKey(records);
	records = await readDongleMetadata(deps);
	return snapshotKey(records) !== before;
}

/** The cached records, keyed by host veth name. */
export function getDongleRecords(): ReadonlyMap<string, DongleMetadata> {
	return records;
}

/** The wire marker for an interface, or `undefined` when it is not a dongle. */
export function getDongleMarker(ifname: string): DongleMarker | undefined {
	const record = records.get(ifname);
	if (!record) return undefined;
	return { slot: record.slot, state: record.state };
}

/**
 * The operator-facing label for a claimed dongle's host veth (`dongle<N>`),
 * or `undefined` for any interface with no live claim.
 */
export function dongleSlotLabel(ifname: string): string | undefined {
	const record = records.get(ifname);
	return record ? `dongle${record.slot}` : undefined;
}

/** Does this name have the host-veth shape? (Shape only — never a claim.) */
export function isDongleVethName(name: string): boolean {
	return DONGLE_VETH_RE.test(name);
}

/** Drop the cached snapshot and the once-per-reason log state (test seam). */
export function resetDongleMetadata(): void {
	records = new Map();
	reportedRejections.clear();
}
