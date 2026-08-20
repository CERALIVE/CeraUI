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

/**
 * Whether a band-lock control may be offered for one modem — capability, and
 * certification, kept as two separate answers.
 *
 * CAPABILITY is what the modem says: a non-empty `SupportedBands` is `present`,
 * an empty one is `absent`, and a read that did not happen is `unknown`. The
 * third is not a formality — the ladder stops at `enabled` for `unknown`, which
 * is surfaced by nothing and mutated by nothing, so an unreadable modem loses a
 * control rather than gaining a broken one.
 *
 * CERTIFICATION is what a reviewer proved, and for THIS module it is what gates
 * the control rather than merely what gates a doc claim. That is a deliberate
 * deviation from the framework floor in `capability-modules.schema.ts`, which
 * offers at `capable` because hiding an uncertified-but-working control puts
 * hardware behind a paperwork gate. Here the paperwork IS the safety argument: a
 * band the SIM's network does not operate on registers nowhere, and a modem that
 * does not honour a reset leaves the operator with no way back short of a replug
 * they may not be able to reach. The deviation is recorded in both repos'
 * AGENTS.md so it reads as a decision rather than as drift.
 *
 * THE CATALOG IS RESOLVED AT RUNTIME. The band API landed in
 * `@ceralive/modem-control` after the version pinned in `package.json`, so a
 * static import would fail the build rather than degrade. The probe mirrors
 * `usage-policy.ts` exactly, and it FAILS CLOSED: a package with no band catalog
 * certifies nothing, which hides the control.
 *
 * THE CACHE EXISTS BECAUSE THE WIRE BUILD IS SYNCHRONOUS. `buildModemsWireMessage`
 * cannot await an mmcli read, so this follows the `policy-route-check.ts`
 * precedent: an async refresh writes a snapshot and a sync getter serves it. It
 * is refreshed from the band RPCs — the surface the operator's UI asks first —
 * rather than from the 30 s poll, because a band list is a property of the
 * hardware and does not move between reads.
 */

import type { CapabilityEvidence } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

import { readModemBands } from "./band-mmcli.ts";
import { defaultResolveIdentity } from "./usb-mode-identity.ts";

export interface BandSku {
	readonly vidPid: string;
	readonly model: string;
	readonly firmwarePrefix: string;
}

interface BandCatalogPackage {
	readonly catalog: unknown;
	readonly isCertified: (catalog: unknown, sku: BandSku | undefined) => boolean;
	readonly findEntry: (catalog: unknown, sku: BandSku) => unknown;
	readonly offerable: (
		entry: unknown,
		supported: readonly string[],
	) => readonly string[];
}

let injected: BandCatalogPackage | null | undefined;
let resolved: BandCatalogPackage | null | undefined;

/** Test seam (the `set*Runner` convention). `null` pins the older-pin arm. */
export function setBandCatalogPackageForTest(
	pkg: BandCatalogPackage | null | undefined,
): void {
	injected = pkg;
	resolved = undefined;
}

async function resolveCatalog(): Promise<BandCatalogPackage | null> {
	if (injected !== undefined) return injected;
	if (resolved !== undefined) return resolved;
	try {
		const mod = (await import("@ceralive/modem-control")) as Record<
			string,
			unknown
		>;
		const catalog = mod.BAND_CERTIFICATION_CATALOG;
		const isCertified = mod.isBandControlCertified;
		const findEntry = mod.findBandCertification;
		const offerable = mod.offerableBands;
		if (
			catalog === undefined ||
			typeof isCertified !== "function" ||
			typeof findEntry !== "function" ||
			typeof offerable !== "function"
		) {
			logger.info("the pinned modem-control publishes no band catalog", {
				module: "modems",
			});
			resolved = null;
			return null;
		}
		resolved = {
			catalog,
			isCertified: isCertified as BandCatalogPackage["isCertified"],
			findEntry: findEntry as BandCatalogPackage["findEntry"],
			offerable: offerable as BandCatalogPackage["offerable"],
		};
		return resolved;
	} catch (err) {
		logger.warn("resolving the band catalog failed", { module: "modems", err });
		resolved = null;
		return null;
	}
}

export interface BandCapabilitySnapshot {
	readonly capability: CapabilityEvidence;
	readonly certified: boolean;
	readonly supported: readonly string[];
	readonly current: readonly string[];
	readonly offerable: readonly string[];
}

const cache = new Map<string, BandCapabilitySnapshot>();

export function resetBandCapabilityCache(): void {
	cache.clear();
	resolved = undefined;
}

export type BandIdentityResolver = typeof defaultResolveIdentity;

let identityResolver: BandIdentityResolver = defaultResolveIdentity;

/** Test seam (the `set*Runner` convention) — the resolver enumerates real USB. */
export function setBandIdentityResolver(
	resolver: BandIdentityResolver | null,
): void {
	identityResolver = resolver ?? defaultResolveIdentity;
}

/** Resolve the SKU this device certifies under, or `undefined`. */
export async function resolveBandSku(
	deviceId: string,
): Promise<{ sku: BandSku; stableKey: string } | undefined> {
	const identity = await identityResolver(deviceId);
	if (identity === undefined) return undefined;
	return {
		stableKey: identity.stableKey,
		sku: {
			vidPid: identity.vidPid,
			model: identity.model,
			// The catalog matches a firmware FAMILY as a prefix of the device's FULL
			// revision, so the FULL revision is what it must be given — truncating
			// here would decide the family boundary the reviewer owns.
			firmwarePrefix: identity.firmwareRevision,
		},
	};
}

/**
 * Read the modem, ask the catalog, and record the answer for the sync getters.
 *
 * A modem whose SKU cannot be resolved is still READ: the capability answer is
 * about the hardware and is worth having even when certification is not
 * resolvable, and reporting `unknown` for a device we successfully read would
 * lose the one honest thing we learned.
 */
export async function refreshBandCapability(
	deviceId: string,
	stableKey: string,
): Promise<BandCapabilitySnapshot> {
	const read = await readModemBands(deviceId);
	const capability: CapabilityEvidence = !read.ok
		? "unknown"
		: read.supported.length > 0
			? "present"
			: "absent";
	const supported = read.ok ? read.supported : [];
	const current = read.ok ? read.current : [];

	const pkg = await resolveCatalog();
	const identity = await resolveBandSku(deviceId);
	const certified =
		pkg !== null &&
		identity !== undefined &&
		pkg.isCertified(pkg.catalog, identity.sku);
	const entry =
		pkg !== null && identity !== undefined
			? pkg.findEntry(pkg.catalog, identity.sku)
			: undefined;
	const offerable =
		pkg !== null && certified ? pkg.offerable(entry, supported) : [];

	const snapshot: BandCapabilitySnapshot = {
		capability,
		certified,
		supported,
		current,
		offerable,
	};
	cache.set(stableKey, snapshot);
	return snapshot;
}

export function getBandCapability(
	stableKey: string | undefined,
): BandCapabilitySnapshot | undefined {
	return stableKey === undefined ? undefined : cache.get(stableKey);
}

/** The capability half of the evidence, for `capability-evidence.ts`. */
export function bandLockEvidence(
	stableKey: string | undefined,
): CapabilityEvidence {
	return getBandCapability(stableKey)?.capability ?? "unknown";
}

/** The certification half. Fails closed for a modem nothing has read yet. */
export function isBandLockCertified(stableKey: string | undefined): boolean {
	return getBandCapability(stableKey)?.certified === true;
}
