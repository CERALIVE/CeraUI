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
  THE TELEMETRY REGISTRY — a UI row is a PHYSICAL DEVICE, not a file position.

  `conn_id` is a POSITION in `BIND_IPS_FILE` (todo 8 says so in as many words),
  so a SIGHUP that republishes the bond in a different order hands the same
  modem a different one. Keying a rendered row on it therefore moves an
  operator's RTT/NAK numbers onto the other twin the moment the order changes —
  the classic defect this whole plan exists to end.

  `link_id` is todo 10's minted, deterministic, position-independent identity.
  It is what the bind-map writer publishes and what the sender echoes back, so
  it is the ONLY key a row may be identified by. `conn_id` survives strictly as
  the LEGACY fallback for a launch that has no mapping at all.

  WHAT THIS MODULE HOLDS is exactly what the WRITER published, and that stays
  the right thing to hold even though the sender's echo is readable. A retired
  comment here claimed the pinned `@ceralive/srtla-send` build stripped
  `link_id`/`iface`; `2026.8.0` in fact declares and parses both, so the echo
  outranks the file position today. The writer's own record is still what makes
  twin disambiguation work when a sender reports NEITHER — it is the floor the
  ladder falls back to, not a stand-in for an unreadable field.

  DISAMBIGUATION IS iface + PORT LABEL, AND NEVER A FABRICATED SERIAL. Todo 10
  measured the HiLink twins on the bench: they publish NO usable USB serial and
  share one factory MAC, so the only thing that separates them is WHICH PORT
  each is in. A serial rides a row ONLY when the device actually reports one.
*/

import type { BondLinkIdentityState } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { resolveModemPhysicalIdentity } from "../modems/physical-identity-source.ts";
import { type BondEntry, isUnmappableEntry } from "./bind-map.ts";

/** One bonded link, as a rendered row needs to identify it. */
export interface LinkIdentity {
	/**
	 * Todo 10's minted id — the row's identity, position-independent. ABSENT
	 * exactly when {@link LinkIdentity.identityState} is `unmappable`: there is
	 * one minting authority, and a link it could not answer for gets the state
	 * rather than a stand-in id.
	 */
	readonly linkId?: string;
	/** The explicit identity verdict the writer published for this link. */
	readonly identityState: BondLinkIdentityState;
	readonly iface: string;
	readonly ip: string;
	/** udev `ID_PATH`, when the writer published one. Diagnostic. */
	readonly idPath?: string;
	/** Human port identity derived from {@link idPath}; absent when underivable. */
	readonly portLabel?: string;
	/** ONLY present when the device itself reports one. Never fabricated. */
	readonly serial?: string;
}

const USB_MARKER = "-usb-";

/**
 * The port an `ID_PATH` names, in the notation Linux itself uses for a USB port.
 *
 * `platform-fc880000.usb-usb-0:1.3.1:1.0` -> `USB 0-1.3.1`. The `<bus>-<chain>`
 * pair IS the physical port, which is precisely the fact that separates two
 * otherwise identical dongles, and it is stable across a replug into the same
 * socket.
 *
 * A path with no USB ancestry (a PCIe/SoC-attached modem) yields `undefined`
 * rather than the raw path: such a device has no same-model twin leasing it the
 * same address, so an unreadable bus-topology string would be noise rather than
 * disambiguation.
 */
export function portLabelFromIdPath(
	idPath: string | undefined,
): string | undefined {
	const path = idPath?.trim();
	if (!path) return undefined;

	const markerAt = path.lastIndexOf(USB_MARKER);
	if (markerAt < 0) return undefined;

	const [busnum, portChain] = path
		.slice(markerAt + USB_MARKER.length)
		.split(":");
	if (!busnum || !portChain) return undefined;
	return `USB ${busnum}-${portChain}`;
}

/** Resolves the facts only a live device can answer. Injected for tests. */
export type LinkIdentityDetailResolver = (
	iface: string,
) => { readonly serial?: string } | undefined;

const defaultDetailResolver: LinkIdentityDetailResolver = (iface) => {
	try {
		const record = resolveModemPhysicalIdentity(iface);
		return record.serial === undefined ? {} : { serial: record.serial };
	} catch (err) {
		// A link whose descriptors could not be read is still a link; it simply
		// carries no serial tail. Never fatal to a publication.
		logger.debug("link-registry: identity detail unavailable", { iface, err });
		return undefined;
	}
};

let detailResolver: LinkIdentityDetailResolver = defaultDetailResolver;

/** Test seam: replace the live detail resolver (null restores the real one). */
export function setLinkIdentityDetailResolverForTest(
	fn: LinkIdentityDetailResolver | null,
): void {
	detailResolver = fn ?? defaultDetailResolver;
}

// File order IS the registry's third key: without a sender echo, `conn_id` is a
// line position into exactly this array (todo 8), so the array must be stored in
// publication order and replaced wholesale on every republication.
let identities: LinkIdentity[] = [];
let byLinkId = new Map<string, LinkIdentity>();
let byIface = new Map<string, LinkIdentity>();

/**
 * Adopt what the writer just published as the registry's whole truth.
 *
 * REPLACEMENT, never a merge: a republication is the complete new bond, so a
 * link that left it must stop resolving rather than linger with the numbers it
 * had when it was last seen.
 */
export function registerBondIdentities(entries: readonly BondEntry[]): void {
	identities = entries.map((entry) => {
		const portLabel = portLabelFromIdPath(entry.idPath);
		const serial = detailResolver(entry.iface)?.serial;
		const unmappable = isUnmappableEntry(entry) || entry.linkId === undefined;
		return {
			identityState: unmappable ? "unmappable" : "resolved",
			...(unmappable ? {} : { linkId: entry.linkId }),
			iface: entry.iface,
			ip: entry.ip,
			...(entry.idPath !== undefined ? { idPath: entry.idPath } : {}),
			...(portLabel !== undefined ? { portLabel } : {}),
			...(serial !== undefined && serial !== "" ? { serial } : {}),
		};
	});

	// An unmappable link is deliberately absent from this index: it is keyed by
	// interface only, so nothing can look it up by an id it does not have.
	byLinkId = new Map(
		identities.flatMap((identity) =>
			identity.linkId === undefined ? [] : [[identity.linkId, identity]],
		),
	);
	byIface = new Map(identities.map((identity) => [identity.iface, identity]));
}

/** Retire the registry — a stopped sender describes no bond. */
export function resetBondIdentities(): void {
	identities = [];
	byLinkId = new Map();
	byIface = new Map();
}

/** The identity the writer minted for `linkId`, if it is still published. */
export function identityForLinkId(
	linkId: string | undefined,
): LinkIdentity | undefined {
	return linkId === undefined ? undefined : byLinkId.get(linkId);
}

/** The identity currently published for `iface`, if any. */
export function identityForIface(
	iface: string | undefined,
): LinkIdentity | undefined {
	return iface === undefined ? undefined : byIface.get(iface);
}

/**
 * The identity at a `BIND_IPS_FILE` LINE position.
 *
 * Only meaningful while a mapping is in force: without one the sender collapses
 * duplicate source IPs, so its `conn_id` counts UNIQUE addresses rather than
 * lines and the two numberings diverge exactly where the twins are.
 */
export function identityAtLine(index: number): LinkIdentity | undefined {
	if (!Number.isInteger(index) || index < 0) return undefined;
	return identities[index];
}

/** How many links the writer last published. */
export function bondIdentityCount(): number {
	return identities.length;
}
