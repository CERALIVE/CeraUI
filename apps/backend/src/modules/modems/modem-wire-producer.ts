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
  The COMPOSITION ROOT of the `modems` wire projection.

  `modem-wire-projection.ts` + `modem-wire-adapters.ts` are pure: they know how
  to normalize a source and how to serialize the result, and they deliberately
  own no state and read no device. This module is the half that does — it
  resolves WHICH sources exist right now (mmcli modems from `modems-state`,
  router-mode dongles from the netns metadata reader), supplies the one input
  the mmcli adapter cannot derive for itself (the udev `ID_PATH` behind each
  modem), and retains the synthetic-id map across snapshots so a replugged
  dongle keeps its wire id.

  Two properties are load-bearing and easy to lose in a refactor:

  1. **`ID_PATH` resolution is ASYNC, the wire build is SYNC.** `buildModemsMessage`
     is called from the post-login push and from a monitor-driven diff, neither of
     which can await a `udevadm` spawn. So this follows the `policy-route-check.ts`
     precedent exactly: an async refresh writes a cache, and a sync getter reads
     it. An unresolved ifname yields no `stable_key` — which is the pre-Phase-B
     wire, i.e. the honest answer for a device we cannot anchor, never a fake key.
  2. **The retained `syntheticIds` map is state the projector refuses to own.**
     `projectModemWire` returns the allocation it made and expects it back as
     `previousSyntheticIds`; drop that round-trip and every poll renumbers the
     dongles.
*/

import type {
	ModemDataUsagePolicy,
	ModemFiveGPreference,
	RouterAdmin,
} from "@ceraui/rpc/schemas";
import { deriveModemStableKey, mayRenderModule } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getCellularStack } from "../cellular/cellular-stack.ts";
import { getDbusModemCache } from "../cellular/dbus-modem-cache.ts";
import { getUdevProvisionalCache } from "../cellular/udev-provisional-cache.ts";
import { getDongleRecords } from "../network/dongle-metadata.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { getRouterCellularAdmin } from "../network/router-cellular-admin.ts";
import { getRouterCellularMarkers } from "../network/router-cellular-scan.ts";

import { IMPLEMENTED_MODEM_CAPABILITY_MODULES } from "./capability-evidence.ts";
import {
	resolveCapabilityModuleState,
	resolveModemCapabilityClaims,
} from "./capability-gates.ts";
import { buildFiveGPreferenceView } from "./five-g-preference.ts";
import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import { projectModemCredential } from "./modem-credentials.ts";
import { readModemIdPaths } from "./modem-id-path-source.ts";
import type { ResolvedModemLock } from "./modem-lock-state.ts";
import {
	gateRouterAdminByLock,
	readLockOpenEvidence,
	resolveModemLock,
} from "./modem-lock-state.ts";
import {
	modemUsbModeForStableKey,
	refreshModemUsbModes,
	resetModemUsbModes,
} from "./modem-usb-mode-source.ts";
import {
	type DbusModemView,
	fromDbusView,
	fromMmcliModem,
	fromRouterCellularView,
	fromRouterView,
	type RouterCellularView,
	routerViewFromDongleMetadata,
} from "./modem-wire-adapters.ts";
import {
	type ProjectedModemSource,
	projectModemWire,
	type WireModemsMessage,
} from "./modem-wire-projection.ts";
import {
	getModem,
	getModemIds,
	getModems,
	type Modem,
} from "./modems-state.ts";
import type { PhysicalDeviceRecord } from "./physical-identity.ts";
import { resetPhysicalIdentityRegistry } from "./physical-identity.ts";
import { resolveModemPhysicalIdentity } from "./physical-identity-source.ts";
import {
	getCachedUsagePolicy,
	isUsagePolicySupported,
	usagePolicySlotKey,
} from "./usage-policy.ts";

/** Resolves `ifname → udev ID_PATH` for every enumerable modem-class device. */
export type ModemIdPathReader = () => Promise<ReadonlyMap<string, string>>;

let idPaths: ReadonlyMap<string, string> = new Map();
let retainedSyntheticIds: ReadonlyMap<string, number> = new Map();
const routerCellularIfnames = new Map<string, string>();

/**
 * The identity behind each classified dongle in the LAST collection, keyed by
 * interface. It is what lets the lock projector answer for a `router` row that
 * has an admin surface without answering for one that does not — the retired
 * netns rows share the same `kind` and have no admin API to be locked out of.
 */
const routerCellularIdentities = new Map<string, PhysicalDeviceRecord>();

/**
 * The real reader lives in `modem-id-path-source.ts` — see that module's header
 * for why it reads udev's NET records rather than `@ceralive/modem-control`'s
 * `UsbDeviceSnapshot.ifname`, which is declared but never populated and made
 * this map permanently empty on every real board.
 *
 * It resolves the SAME `ID_PATH` a mode switch correlates on: the netdev record's
 * interface-level path reduces, through the shared `deriveModemStableKey`, to the
 * `usb_device` parent every other adapter keys on.
 */
let readIdPaths: ModemIdPathReader = readModemIdPaths;

/** Test seam, mirroring the `set*Runner` convention. */
export function setModemIdPathReader(reader: ModemIdPathReader | null): void {
	readIdPaths = reader ?? readModemIdPaths;
}

/** The cached `ID_PATH` for an interface, or `undefined` when unresolved. */
export function getModemIdPath(ifname: string): string | undefined {
	return idPaths.get(ifname);
}

/**
 * Re-read the `ifname → ID_PATH` map.
 *
 * Called on PRESENCE edges only (initial discovery, `modem-added`) — an
 * `ID_PATH` is a property of where a device is physically plugged in, so the
 * 30 s status poll cannot move it and paying a `udevadm` spawn per poll would
 * buy nothing.
 *
 * NEVER THROWS, and a failure RETAINS the previous map rather than clearing it:
 * an unreadable udev database is a statement about the read, not about the
 * devices, and dropping every `stable_key` on a transient failure would make
 * each row look like a brand-new device to a frontend correlating across a mode
 * switch.
 */
export async function refreshModemIdPaths(): Promise<void> {
	try {
		idPaths = await readIdPaths();
	} catch (error) {
		logger.debug("modem id-path refresh failed; retaining previous map", {
			error,
		});
	}
	// The USB composition is read on the SAME presence edges and from the same
	// udev database, so a row's `stable_key` and its `usb_mode` are always two
	// facts about one observation rather than two observations.
	await refreshModemUsbModes();
}

/**
 * The RADIO half of the source set — one row per ModemManager-managed modem.
 *
 * Which adapter produces it follows the backend the composition root COMMITTED,
 * never the config key: a `dbus` request that fell back to mmcli must project
 * mmcli rows, or the wire would advertise detail nothing observed.
 */
function collectRadioSources(): ProjectedModemSource[] {
	const stack = getCellularStack();
	if (stack.ready && !stack.degraded && stack.backend === "dbus") {
		const views = readDbusViews();
		if (views.length > 0) {
			return views.map((view) =>
				fromDbusView(
					withSimIdentity(withConnectionConfig(withScanResults(view))),
				),
			);
		}
	}

	const sources: ProjectedModemSource[] = [];
	for (const id of getModemIds()) {
		const modem = getModem(id);
		// The live builder skips a modem with no status and the adapter throws on
		// one — the filter IS the contract, not a convenience.
		if (!modem?.status) continue;
		const idPath = getModemIdPath(modem.ifname);
		const identity = resolveModemPhysicalIdentity(modem.ifname, {
			mm: {
				name: modem.name,
				...(modem.model !== undefined ? { model: modem.model } : {}),
				...(modem.manufacturer !== undefined
					? { manufacturer: modem.manufacturer }
					: {}),
			},
			...(idPath !== undefined ? { idPath } : {}),
		});
		sources.push(
			fromMmcliModem(id, modem, {
				identity,
				...(idPath !== undefined ? { idPath } : {}),
			}),
		);
	}
	return sources;
}

/**
 * The D-Bus half of the radio sources.
 *
 * An EMPTY answer is not a failure — it means mmcli is authoritative right now:
 * either nothing has been observed yet, or the cache demoted itself below mmcli
 * because our client failed while ModemManager stayed answerable. The opposite
 * failure (the MM bus name has no owner) deliberately keeps serving RETAINED,
 * stale-marked rows, because mmcli talks to the same dead daemon and has no
 * better answer. Both rules live in `docs/DBUS-OBSERVATION-CONTRACT.md` §(d).
 */
/**
 * Attach the last 3GPP scan's results to a D-Bus view.
 *
 * The scan is an mmcli operation (`modem-network-scan.ts`), so it writes into
 * the mmcli-side modem state — and the D-Bus fold has no `NetworkRejection`-like
 * property to read them back from, because MM does not publish a scan result as
 * a property at all. So the two halves must be joined HERE, at the composition
 * root, which is the only place that can see both.
 *
 * Without it a scan under the DEFAULT backend ran, succeeded, and reached the
 * operator as an unchanged (empty) network list — a scan that silently did
 * nothing, which is the second half of the "scan is failing" report.
 *
 * The join key is the MM index: both sides are ModemManager runtime ids for the
 * same daemon, so `runtimeId` IS the mmcli id. A view whose modem the mmcli side
 * has never scanned is returned UNCHANGED rather than given an empty list — an
 * empty list is a claim that a scan found nothing.
 */
function withScanResults(view: DbusModemView): DbusModemView {
	if (view.availableNetworks !== undefined) return view;
	const scanned = getModem(view.runtimeId)?.available_networks;
	if (scanned === undefined) return view;
	return { ...view, availableNetworks: scanned };
}

/**
 * Attach the modem's NetworkManager connection profile to a D-Bus view.
 *
 * The SIBLING of {@link withScanResults}, for the same structural reason: the
 * profile is NetworkManager's, written into the mmcli-side modem state by
 * `registerModem`/`applyModemConfig`, and ModemManager publishes no property the
 * fold could read it back from — so the two halves can only be joined HERE, at
 * the one place that sees both. `DbusModemView.config` has always declared the
 * field; nothing ever filled it.
 *
 * Omission was SILENT, because the block is optional: `modemConfigEchoMatches`
 * returns `false` on a missing config, so a save the device ACCEPTED could never
 * be confirmed and the dialog span to its TTL with no result either way.
 * Board-measured on a Quectel RM530N-GL: `modems.configure` answered
 * `{"success":true,…,"reconnected":false}` in 469 ms while the very next
 * `modems.getAll` carried no `config` key at all.
 *
 * Join key is the MM index, exactly as above. A modem the mmcli side holds no
 * profile for is returned UNCHANGED — "not yet provisioned" must stay absent
 * rather than become an empty profile the dialog renders as a real, blank one.
 * The `conn` UUID is deliberately NOT copied: it is internal routing state, and
 * the mmcli adapter does not put it on the wire either.
 */
function withConnectionConfig(view: DbusModemView): DbusModemView {
	if (view.config !== undefined) return view;
	const config = getModem(view.runtimeId)?.config;
	if (config === undefined) return view;
	return {
		...view,
		config: {
			apn: config.apn,
			username: config.username,
			password: config.password,
			roaming: config.roaming,
			network: config.network,
			autoconfig: config.autoconfig,
		},
	};
}

/**
 * Attach the SIM's ICCID to a D-Bus view.
 *
 * The THIRD sibling of {@link withScanResults} / {@link withConnectionConfig},
 * and the structural reason is sharper here: ModemManager's ObjectManager at
 * `/org/freedesktop/ModemManager1` exports ONLY `Modem` objects, so the SIM
 * object the ICCID lives on is not in the `GetManagedObjects` tree the fold is
 * given — it is a separate D-Bus object reachable only by its own `Get` call.
 * `dbus-view-fold.ts` `readIccid` therefore cannot resolve it on real hardware.
 *
 * Board-measured on `ceralive2` (2026-08-18), against a Quectel RM530N-GL whose
 * SIM `busctl` reads perfectly at `/SIM/2`:
 *
 *   object-dict length ......................... 4   (all `Modem/*`)
 *   occurrences of `…ModemManager1.Sim` iface ... 0
 *   occurrences of `SimIdentifier` .............. 0
 *
 * mmcli reads it fine (`mmcli -i <sim-path>`, already parsed at registration and
 * already used to resolve the NM profile), and the mmcli side keeps running under
 * the D-Bus default as the 30 s reconciliation backstop — so, exactly as for a
 * scan result and an NM profile, the two halves can only be joined HERE.
 *
 * Join key is the MM index, as above. A modem the mmcli side holds no ICCID for
 * is returned UNCHANGED — a card that withheld its identifier must stay absent
 * rather than become an empty string the dialog renders as a row.
 *
 * NOTE the same tree gap silently disables `readEsim`, which reads that same SIM
 * object: `modem.esim` has never been populated on a real board. That is a
 * PRE-EXISTING defect, out of scope here, and deliberately not papered over —
 * fixing it needs the same join or a real per-SIM `Get`.
 */
function withSimIdentity(view: DbusModemView): DbusModemView {
	if (view.iccid !== undefined) return view;
	const iccid = getModem(view.runtimeId)?.iccid;
	if (iccid === undefined || iccid.length === 0) return view;
	return { ...view, iccid };
}

function readDbusViews(): readonly DbusModemView[] {
	if (shouldUseMocks()) {
		return mockDbusViews?.() ?? [];
	}
	return getDbusModemCache().readViews();
}

let mockDbusViews: (() => readonly DbusModemView[]) | undefined;

/** Installed by the mock boot path so the dev graph stays lazily loaded. */
export function setMockDbusModemViews(
	reader: (() => readonly DbusModemView[]) | null,
): void {
	mockDbusViews = reader ?? undefined;
}

/**
 * The router-dongle half that needs no netns layer.
 *
 * `getDongleRecords()` only ever answers on an image running the isolation
 * manager, which no shipped image does — so before this, a classified dongle
 * produced a `netif` marker and no modem row at all, and the Cellular section
 * could not list the one device class it most obviously describes. The
 * classifier cache is reused verbatim as the single classification signal; this
 * function adds no second opinion about what a device is.
 */
function collectRouterCellularSources(): ProjectedModemSource[] {
	const netif = getNetworkInterfaces();
	const sources: ProjectedModemSource[] = [];
	routerCellularIfnames.clear();
	routerCellularIdentities.clear();
	for (const [ifname, marker] of getRouterCellularMarkers()) {
		const entry = netif[ifname];
		if (entry === undefined) continue;
		const observed = getRouterCellularAdmin(ifname) as RouterAdmin | undefined;
		const identity = resolveModemPhysicalIdentity(ifname, {
			...(observed !== undefined ? { routerAdmin: observed } : {}),
			...(marker.serial !== undefined ? { unitLabel: marker.serial } : {}),
		});
		// THE CAPABILITY GATE. A row that cannot authenticate must not advertise
		// the operations that need a session — and the same row offers them again
		// the moment a verify lands, through this same rebuild. The reading's
		// OBSERVATIONS (admin URL, model, SIM, signal) pass through untouched:
		// those are facts rather than offers, and withholding them would report a
		// reachable device as unreadable.
		const admin =
			observed === undefined
				? undefined
				: gateRouterAdminByLock(
						observed,
						resolveRouterCellularLock(ifname, identity).state,
					);
		const view: RouterCellularView = {
			ifname,
			vendor: marker.vendor,
			model: marker.model,
			vidPid: marker.vid_pid,
			hasAddress: entry.ip !== undefined && entry.ip !== "",
			identity,
			...(marker.serial !== undefined ? { serial: marker.serial } : {}),
			...(admin !== undefined ? { admin } : {}),
		};
		routerCellularIfnames.set(identity.stableKey ?? routerKey(ifname), ifname);
		routerCellularIdentities.set(ifname, identity);
		sources.push(fromRouterCellularView(view));
	}
	return sources;
}

function resolveRouterCellularLock(
	ifname: string,
	identity: PhysicalDeviceRecord,
): ResolvedModemLock {
	return resolveModemLock({
		identityKey: identity.identityKey,
		openEvidence: readLockOpenEvidence(ifname),
		credential: projectModemCredential(identity),
	});
}

/** The lock block for a row, or `undefined` for a device with no admin surface. */
function projectModemLock(
	source: ProjectedModemSource,
): ResolvedModemLock | undefined {
	const identity = routerCellularIdentities.get(source.ifname);
	return identity === undefined
		? undefined
		: resolveRouterCellularLock(source.ifname, identity);
}

/**
 * Every key an AUTHORITATIVE source already occupies.
 *
 * Both are needed and neither is redundant: `stableKey` is the `ID_PATH`-derived
 * wire identity a provisional row is matched on, and `allocationKey` is the
 * synthetic-id grouping key, which a device with no `ID_PATH` falls back to. A
 * provisional row is only ever created for a device that HAS an `ID_PATH`, so in
 * practice the first is what fires; the second costs nothing and closes the gap
 * if a future adapter keys differently.
 */
function claimedIdentityKeys(
	sources: readonly ProjectedModemSource[],
): ReadonlySet<string> {
	const claimed = new Set<string>();
	for (const source of sources) {
		if (source.stableKey !== undefined) {
			claimed.add(source.stableKey);
		}
		claimed.add(source.allocationKey);
	}
	return claimed;
}

function collectAuthoritativeSources(): ProjectedModemSource[] {
	const sources = collectRadioSources();
	for (const metadata of getDongleRecords().values()) {
		sources.push(fromRouterView(routerViewFromDongleMetadata(metadata)));
	}
	sources.push(...collectRouterCellularSources());
	return sources;
}

export function noteAuthoritativeModemCycle(): void {
	const sources = collectAuthoritativeSources();
	getUdevProvisionalCache().noteAuthoritativeCycle(
		claimedIdentityKeys(sources),
	);
}

function collectSources(): ProjectedModemSource[] {
	const sources = collectAuthoritativeSources();

	// PROVISIONAL ROWS GO LAST, AND ONLY WHERE NOTHING AUTHORITATIVE STANDS.
	//
	// Precedence is one-directional by construction here: the claimed set is
	// built from the sources already collected, so an mmcli row, a D-Bus row or a
	// classified dongle for the same `ID_PATH` REPLACES the optimistic row within
	// the same synchronous wire build — a provisional row can never displace,
	// enrich or delay a real observation. Appending rather than interleaving also
	// keeps the existing rows' order byte-identical.
	sources.push(...readProvisionalSources(claimedIdentityKeys(sources)));
	return sources;
}

/**
 * The optimistic "Modem detected — initializing…" rows (todo 18).
 *
 * Mocks answer with NOTHING rather than with a fixture: this row exists to close
 * a real hardware latency gap that a dev host does not have, and the udev
 * monitor that fills it is `isRealDevice()`-gated for the same reason. A mock
 * scenario inventing one would be a parallel mechanism to the scenario roster,
 * not the established one.
 */
function readProvisionalSources(
	claimed: ReadonlySet<string>,
): readonly ProjectedModemSource[] {
	if (shouldUseMocks()) {
		return [];
	}
	return getUdevProvisionalCache().readProvisionalSources(claimed);
}

/**
 * Build the projected `modems` wire message and retain the allocation it made.
 *
 * `fullState` has the SAME meaning as on the legacy builder: `undefined` ⇒ every
 * entry carries its full descriptor, otherwise only the listed MM ids do.
 */
export function buildProjectedModemsMessage(
	fullState: Record<number, true> | undefined = undefined,
): WireModemsMessage {
	const result = projectModemWire(collectSources(), {
		hasGsmAutoconfig: resolveGsmAutoconfigSupport(),
		networkScanFor: (runtimeId) => getModem(runtimeId)?.network_scan,
		previousSyntheticIds: retainedSyntheticIds,
		usagePolicyFor: projectUsagePolicy,
		// The implemented list is passed EXPLICITLY rather than left to the
		// framework's own (still empty) default: a module with a live probe and a
		// live mutation path must resolve on the wire the same way it resolves at
		// the mutation gate, or the row says `unavailable` for a control the
		// device would happily accept.
		capabilityModulesFor: (stableKey) =>
			resolveModemCapabilityClaims(
				stableKey,
				IMPLEMENTED_MODEM_CAPABILITY_MODULES,
			),
		fiveGPreferenceFor: projectFiveGPreference,
		usbModeFor: modemUsbModeForStableKey,
		lockFor: projectModemLock,
		...(fullState !== undefined ? { fullState } : {}),
	});
	retainedSyntheticIds = result.syntheticIds;
	return result.message;
}

/**
 * The `five-g-pref` read block for a row, or `undefined` when its claim is not
 * SURFACEABLE.
 *
 * The gate is asked through the SAME `resolveModemCapabilityClaims` +
 * `mayRenderModule` pair the frontend renders from, so the row cannot advertise
 * a posture list for a module the ladder says may not be offered — and a
 * consumer never re-derives the ladder to decide whether to draw the control.
 */
function projectFiveGPreference(
	stableKey?: string,
): ModemFiveGPreference | undefined {
	const state = resolveCapabilityModuleState(
		"five-g-pref",
		stableKey,
		IMPLEMENTED_MODEM_CAPABILITY_MODULES,
	);
	if (!mayRenderModule(state)) return undefined;

	const modem = modemForStableKey(stableKey);
	return modem === undefined
		? undefined
		: buildFiveGPreferenceView(modem.radio_modes);
}

function modemForStableKey(stableKey: string | undefined): Modem | undefined {
	if (stableKey === undefined || stableKey === "") return undefined;
	for (const modem of Object.values(getModems())) {
		const idPath = getModemIdPath(modem.ifname);
		if (idPath !== undefined && deriveModemStableKey(idPath) === stableKey) {
			return modem;
		}
	}
	return undefined;
}

function routerKey(ifname: string): string {
	return `router-cellular:${ifname}`;
}

/**
 * The interface behind a router-dongle row's wire id, or `undefined`.
 *
 * A router dongle has no ModemManager entry, so its wire id exists ONLY in the
 * retained synthetic allocation — the same map the last projection handed the
 * frontend. Reading it here is what lets a mutation address the exact device the
 * operator was looking at, and an id belonging to any other kind of modem
 * resolves to `undefined` rather than to a neighbouring interface.
 *
 * The allocation key is no longer PARSEABLE back into an interface: once a
 * classified dongle carries a real `stable_key`, its key is an ID_PATH, which
 * names a PORT rather than a name. So the last collection records the mapping
 * explicitly, and an id whose key was not recorded by that collection answers
 * `undefined` instead of resolving to a neighbouring interface.
 */
export function routerCellularIfnameForWireId(id: number): string | undefined {
	for (const [allocationKey, allocatedId] of retainedSyntheticIds) {
		if (allocatedId !== id) continue;
		return routerCellularIfnames.get(allocationKey);
	}
	return undefined;
}

/**
 * The operator's persisted data-usage policy for one row.
 *
 * `supported` is written EXPLICITLY on every row, never present-only-when-true:
 * the frontend merge preserves an omitted optional field, so a true-only flag
 * could be raised and never lowered — the `policy_route_missing` latch, exactly.
 */
function projectUsagePolicy(
	legacyId: string,
	stableKey?: string,
): ModemDataUsagePolicy {
	const policy = getCachedUsagePolicy(usagePolicySlotKey(legacyId, stableKey));
	return {
		supported: isUsagePolicySupported(),
		...(policy?.cycleDay !== undefined ? { cycle_day: policy.cycleDay } : {}),
		...(policy?.thresholdBytes !== undefined
			? { threshold_bytes: policy.thresholdBytes }
			: {}),
	};
}

/** Drop the caches, the retained allocation, and both injected readers. */
export function resetModemWireProducer(): void {
	idPaths = new Map();
	retainedSyntheticIds = new Map();
	routerCellularIfnames.clear();
	routerCellularIdentities.clear();
	resetPhysicalIdentityRegistry();
	readIdPaths = readModemIdPaths;
	resetModemUsbModes();
	mockDbusViews = undefined;
}
