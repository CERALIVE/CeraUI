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
  THE WRITER SIDE OF ADR-003 — pure half.

  `srtla-send-rs/docs/adr/ADR-003-bind-map-contract.md` defines the READER; this
  module defines the document that reader parses, byte-for-byte compatibly. Two
  files, one directory, one writer:

    BIND_IPS_FILE  newline-separated source IPs — BYTE-UNCHANGED from the legacy
                   contract, because every deployed sender and every hand-run
                   invocation still reads it in exactly that form.
    sidecar        the versioned JSON that describes that file POSITIONALLY.

  ROW CORRESPONDENCE is the whole mechanism: the Nth `links[]` row describes the
  Nth ACCEPTED line of the IP file, where "accepted" is the sender's own legacy
  `read_ip_list` rule (trim, skip blank, skip unparseable, DUPLICATES PRESERVED).
  Two rows may therefore both say `192.168.8.100` — that is what tells two
  identical HiLink twins apart, and it is the reason the writer must never
  de-duplicate the list it emits.

  Nothing here touches a file. {@link buildBindMapDocument} produces the exact
  value the sender parses and {@link collisionGroups} names the same-IP groups
  the writer has to be honest about when the map is NOT in force; the effectful
  publication lives in `bind-map-writer.ts`.
*/

import type { BondLinkIdentityState } from "@ceraui/rpc/schemas";

/** One bonded uplink, as the writer knows it before anything is published. */
export interface BondEntry {
	/** Source IPv4/IPv6 literal — the line that goes in `BIND_IPS_FILE`. */
	readonly ip: string;
	/** Kernel interface name the socket must egress through. */
	readonly iface: string;
	/**
	 * Opaque identity minted by todo 10's `mintLinkId`. Never invented here, and
	 * ABSENT exactly when {@link BondEntry.identityState} says `unmappable`.
	 */
	readonly linkId?: string;
	/** Writer provenance for a human debugging a bond; opaque to the sender. */
	readonly idPath?: string;
	/**
	 * The EXPLICIT identity verdict. Absent means `resolved` — every caller that
	 * carries a `linkId` says so by carrying one — and `unmappable` is the only
	 * value ever written, by {@link unmappableBondEntry} alone.
	 */
	readonly identityState?: BondLinkIdentityState;
}

/** A {@link BondEntry} the writer can turn into a row: it carries a minted id. */
export type MappedBondEntry = BondEntry & { readonly linkId: string };

/**
 * The entry for a link whose physical identity could NOT be resolved.
 *
 * There is deliberately no id here and no way to pass one in. The retired
 * fallback minted `lnk_<ifname>` — a string shaped exactly like a real minted id
 * but keyed on the INTERFACE NAME, which this fleet has already proven is not a
 * device: two same-model dongles swap names on a replug (they ship one factory
 * MAC, so systemd can only name one of them predictably), so that id follows the
 * name and hands the next device the previous unit's telemetry row. Identity is
 * minted by `physical-identity.ts` and by nothing else; when it cannot be, the
 * honest answer is this state.
 *
 * The entry is KEPT rather than dropped: the link still carries traffic and the
 * operator still has to be told it exists and that it cannot be told apart from
 * a same-IP twin. What it cannot do is become a sidecar row — see
 * {@link isMappableEntry}.
 */
export function unmappableBondEntry(ip: string, iface: string): BondEntry {
	return { ip, iface, identityState: "unmappable" };
}

/** Did identity resolution positively FAIL for this entry? */
export function isUnmappableEntry(entry: BondEntry): boolean {
	return entry.identityState === "unmappable";
}

/** A row of the sidecar's `links[]`, in the sender's own field spelling. */
export interface BindMapRow {
	readonly link_id: string;
	readonly ip: string;
	readonly iface: string;
	readonly id_path?: string;
}

/** The sidecar document. Formatting is NOT part of the contract; the value is. */
export interface BindMapDocument {
	readonly schema_version: 1;
	readonly generation: number;
	readonly ips_file_sha256: string;
	readonly links: readonly BindMapRow[];
}

/** A same-IP group, in the sender's own telemetry spelling (todo 8). */
export interface CollisionGroup {
	readonly ip: string;
	/** `BIND_IPS_FILE` LINE position that survives, not a `conn_id`. */
	readonly effective_index: number;
	/** The line positions the legacy path drops, again NOT `conn_id`s. */
	readonly excluded_indices: readonly number[];
}

export const BIND_MAP_SCHEMA_VERSION = 1;

/** ADR-003 §1.1: 1-15 bytes, no `/`, no whitespace, not `.` or `..`. */
export function isValidIfaceName(iface: string): boolean {
	if (iface.length === 0 || iface.length > 15) return false;
	if (iface === "." || iface === "..") return false;
	return !/[/\s\0]/.test(iface);
}

/** ADR-003 §1.1: 1-64 bytes of printable ASCII, `0x21`-`0x7E`. */
export function isValidLinkId(linkId: string): boolean {
	if (linkId.length === 0 || linkId.length > 64) return false;
	return /^[\x21-\x7e]+$/.test(linkId);
}

/**
 * Can this entry become a valid row?
 *
 * This is the predicate the dup-IP bonding split turns on: a duplicate-IP
 * interface is bonding-eligible exactly when the writer can describe it, because
 * a row is what lets the sender tell it from its twin. An entry that cannot be
 * described is not made eligible by wishing.
 */
export function isMappableEntry(entry: BondEntry): entry is MappedBondEntry {
	if (entry.ip.trim() === "") return false;
	if (entry.linkId === undefined || isUnmappableEntry(entry)) return false;
	return isValidIfaceName(entry.iface) && isValidLinkId(entry.linkId);
}

/**
 * The IP-file bytes for a set of entries.
 *
 * One line per entry, in entry order, duplicates preserved. A trailing newline
 * is emitted so the last line is a complete line; the sender's parser trims and
 * skips the resulting empty tail, which is exactly the legacy behaviour.
 */
export function renderIpsFile(entries: readonly BondEntry[]): string {
	return entries.map((entry) => entry.ip).join("\n");
}

/**
 * Build the sidecar document for `entries` against the ips-file digest.
 *
 * `generation` is the writer's own monotonic per-session counter; the caller
 * owns it, because "same mapping, re-read" and "new mapping, same IPs" are only
 * distinguishable by it (the digest cannot see a mapping-only change).
 */
export function buildBindMapDocument(
	entries: readonly MappedBondEntry[],
	generation: number,
	ipsFileSha256: string,
): BindMapDocument {
	return {
		schema_version: BIND_MAP_SCHEMA_VERSION,
		generation,
		ips_file_sha256: ipsFileSha256,
		links: entries.map((entry) => ({
			link_id: entry.linkId,
			ip: entry.ip,
			iface: entry.iface,
			...(entry.idPath !== undefined ? { id_path: entry.idPath } : {}),
		})),
	};
}

/**
 * The same-IP groups in `entries`, in file order.
 *
 * Used ONLY to be honest when the map is not in force: without a mapping the
 * sender keeps the FIRST occurrence of each group and drops the rest, so the
 * writer — which knows exactly what it published — synthesizes the same verdict
 * rather than leaving an operator with two modems and one unexplained link.
 *
 * Indices are `BIND_IPS_FILE` LINE positions. They are deliberately NOT
 * `conn_id`s: an excluded line never becomes a connection, so the two numberings
 * diverge exactly when this array is non-empty.
 */
export function collisionGroups(
	entries: readonly BondEntry[],
): CollisionGroup[] {
	const byIp = new Map<string, number[]>();
	entries.forEach((entry, index) => {
		const seen = byIp.get(entry.ip);
		if (seen === undefined) byIp.set(entry.ip, [index]);
		else seen.push(index);
	});

	const groups: CollisionGroup[] = [];
	for (const [ip, indices] of byIp) {
		const [effective, ...excluded] = indices;
		if (effective === undefined || excluded.length === 0) continue;
		groups.push({
			ip,
			effective_index: effective,
			excluded_indices: excluded,
		});
	}
	return groups.sort((a, b) => a.effective_index - b.effective_index);
}

/** Two entry lists describe the same mapping (ips AND rows), in order. */
export function sameMapping(
	a: readonly BondEntry[],
	b: readonly BondEntry[],
): boolean {
	if (a.length !== b.length) return false;
	return a.every((entry, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			other.ip === entry.ip &&
			other.iface === entry.iface &&
			other.linkId === entry.linkId &&
			other.idPath === entry.idPath
		);
	});
}
