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
 * The OPTIMISTIC "Modem detected — initializing…" rows, and the precedence rules
 * that keep them from ever outranking a real observation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRECEDENCE IS ONE-DIRECTIONAL, AND IT IS ENFORCED AT THE READ SEAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A provisional row is a claim that a device EXISTS, and nothing more. Any
 * authoritative observation of the same physical device — an mmcli row, a D-Bus
 * row, or a classified router dongle — REPLACES it outright, and a provisional
 * row can never overwrite, enrich, or delay one. {@link readProvisionalSources}
 * takes the set of keys the authoritative sources have already claimed and drops
 * every matching entry, so supersession happens SYNCHRONOUSLY inside the same
 * wire build that produced those sources. There is deliberately no "merge" of
 * fields in either direction: a provisional row carries no observation to merge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MERGE KEY IS THE `ID_PATH`-DERIVED `stable_key`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Todo 10's ladder is `usb-serial` > `id-path` > `ifname`, and it deliberately
 * carries NO alias table between rungs. That is correct for identity and WRONG
 * as a merge key here, because the two sides of this merge sit on different
 * rungs: a udev `usb_device` add publishes `ID_SERIAL_SHORT`, so it would anchor
 * on `usb-serial:…`, while a D-Bus row carries only `Modem.Physdev` and anchors
 * on `id-path:…`. Comparing identity keys across that boundary would never
 * match, and the provisional row would sit beside its own authoritative row as a
 * duplicate — the exact failure this todo forbids.
 *
 * `deriveModemStableKey` is the ONE shared rule every adapter already runs
 * (`@ceraui/rpc`), it is what todo 17's consumers correlate on, and BOTH sides
 * of this merge always carry it. It also survives the `9024`⇄`9091` Qualcomm
 * dual-mode flip for free: that transition changes VID:PID and the interface
 * name but keeps the device in the SAME USB port, so the `ID_PATH` — and
 * therefore the key — is byte-identical in both compositions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT WRITE TO TODO 10's RECORD STORE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `resolvePhysicalDevice()` REMEMBERS what it resolves, so consumers holding a
 * `link_id` can find the device again. A provisional observation is the poorest
 * one this backend ever makes — no ifname, no MM identity, no admin reading —
 * and seeding the store with it would hand the bind-map writer and the telemetry
 * registry a record whose `ifname` is empty, for a device the authoritative
 * sweep is about to describe properly. So this module uses todo 10's PURE rules
 * (`deriveModemStableKey`, `routerCellularDisplayName`) and leaves the store to
 * the observations that can actually fill it.
 */

import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import type { ProjectedModemSource } from "../modems/modem-wire-projection.ts";
import { routerCellularDisplayName } from "../modems/physical-identity.ts";

import type { UdevCellularAttach } from "./udev-cellular-events.ts";

/**
 * The wire token a provisional row carries as its `availability_reason`.
 *
 * It is the ONLY thing that distinguishes the row from a real one on the wire,
 * so the frontend keys its "Modem detected — initializing…" copy on it. Machine
 * token, never rendered raw.
 */
export const PROVISIONAL_AVAILABILITY_REASON = "modem_initializing";

/**
 * How long a provisional row may stand before it is retired unseen.
 *
 * DERIVED, not picked. The mmcli reconciliation backstop polls every 30 s with
 * ±10 % jitter (`modem-update-loop.ts`), so the LAST scheduled moment at which a
 * device could still appear on the authoritative path is ~33 s after the attach,
 * plus the mmcli read and the broadcast that poll performs. 40 s clears that
 * whole window, so expiry can only ever fire for a device that genuinely never
 * exported — never for a slow-but-working one.
 *
 * Expiry REMOVES the row. It does not mark it, dim it, or leave a tombstone:
 * "we optimistically said a modem was coming and it never did" is not a fact
 * about hardware worth keeping on an operator's screen, and a retained
 * expired-provisional state would be a new ghost class.
 */
export const PROVISIONAL_TIMEOUT_MS = 40_000;

export type ProvisionalCacheListener = () => void;

interface ProvisionalEntry {
	readonly stableKey: string;
	readonly idPath: string;
	readonly displayName: string;
	readonly evidence: string;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The display name for a device we have seen only through udev.
 *
 * It runs todo 10's OWN naming rule with the descriptor facts udev supplies, so
 * the provisional row and the authoritative row that replaces it are titled by
 * one implementation. The hwdb model is preferred over the bare product id for
 * the same reason it is there: `Huawei E3372 …` names a device, `14dc` does not
 * — but `14dc` is still the honest floor, and no placeholder is invented.
 */
function provisionalDisplayName(attach: UdevCellularAttach): string {
	const vendor = attach.hwdbVendor ?? "";
	const model =
		attach.hwdbModel ?? attach.pid ?? attach.vid ?? "cellular device";
	return routerCellularDisplayName(vendor, model, undefined);
}

/**
 * The provisional-row store.
 *
 * A class rather than module-level state so a test can own an isolated instance,
 * mirroring `DbusModemCache`; the module singleton below is what the wire
 * producer reads.
 */
export class UdevProvisionalCache {
	readonly #listeners = new Set<ProvisionalCacheListener>();
	readonly #entries = new Map<string, ProvisionalEntry>();
	readonly #timeoutMs: number;

	/**
	 * @param timeoutMs how long an unclaimed row may stand. A CONSTRUCTOR
	 * parameter rather than a direct read of {@link PROVISIONAL_TIMEOUT_MS},
	 * because that value is DERIVED from the 30 s reconciliation poll and a test
	 * that waited it out would cost 40 s per case — the timer path itself stays
	 * real. The shipped singleton below takes the derived value.
	 */
	constructor(timeoutMs: number = PROVISIONAL_TIMEOUT_MS) {
		this.#timeoutMs = timeoutMs;
	}

	/**
	 * Record a cellular-class attach.
	 *
	 * A device with no derivable `stable_key` is IGNORED: the merge key is what
	 * makes the row retirable, and a row nothing could ever supersede is a ghost.
	 * A repeat attach for a key already held is a no-op rather than a timer
	 * reset — a composite device can emit more than one `usb_device` add during
	 * modeswitch, and each one must not extend the window the first opened.
	 */
	noteAttach(attach: UdevCellularAttach): void {
		const stableKey = deriveModemStableKey(attach.idPath);
		if (stableKey === undefined || this.#entries.has(stableKey)) {
			return;
		}
		const timer = setTimeout(() => {
			const entry = this.#entries.get(stableKey);
			if (entry === undefined) {
				return;
			}
			this.#entries.delete(stableKey);
			this.#notify();
		}, this.#timeoutMs);
		timer.unref?.();
		this.#entries.set(stableKey, {
			stableKey,
			idPath: attach.idPath,
			displayName: provisionalDisplayName(attach),
			evidence: attach.evidence,
			timer,
		});
		this.#notify();
	}

	/** Retire the row for a detached device. Unknown paths are a no-op. */
	noteDetach(idPath: string): void {
		const stableKey = deriveModemStableKey(idPath);
		if (stableKey === undefined) {
			return;
		}
		if (this.#drop(stableKey)) {
			this.#notify();
		}
	}

	/**
	 * Drop every provisional row.
	 *
	 * Called when the `udevadm monitor` child restarts: the monitor has no
	 * historical replay, so a device that detached while it was down would leave
	 * a row nothing can ever retire. Discarding the whole set is the honest
	 * response — a device that is still attached and still un-exported has not
	 * been re-announced to us, and claiming otherwise would be a memory of an
	 * event rather than an observation.
	 */
	clear(): void {
		if (this.#entries.size === 0) {
			return;
		}
		for (const key of [...this.#entries.keys()]) {
			this.#drop(key);
		}
		this.#notify();
	}

	/**
	 * The provisional rows that survive supersession, as wire sources.
	 *
	 * `claimedKeys` is every key the authoritative sources already occupy, and a
	 * match RETIRES the entry rather than merely hiding it — the authoritative
	 * row is now the device's representation, so keeping a shadow of it alive
	 * would let the row reappear the moment that observation blinked.
	 */
	readProvisionalSources(
		claimedKeys: ReadonlySet<string>,
	): readonly ProjectedModemSource[] {
		const sources: ProjectedModemSource[] = [];
		for (const entry of [...this.#entries.values()]) {
			if (claimedKeys.has(entry.stableKey)) {
				this.#drop(entry.stableKey);
				continue;
			}
			sources.push({
				kind: "unmanaged",
				runtimeId: null,
				stableKey: entry.stableKey,
				allocationKey: entry.stableKey,
				// No interface exists yet — that is the whole reason this row is
				// provisional. An empty name is the honest answer, and it renders as
				// the row's own "no address, so it cannot bond" reason.
				ifname: "",
				name: entry.displayName,
				networkType: { supported: [], active: null },
				// NO `status` block: nothing has observed this radio, and a zeroed
				// one would draw an empty signal meter that reads as "no signal".
				// NO SIM claim either — `opaque` emits neither `config` nor
				// `no_sim`, both of which would be guesses.
				simVisibility: "opaque",
				additive: {
					availability_reason: PROVISIONAL_AVAILABILITY_REASON,
				},
			});
		}
		return sources;
	}

	subscribe(listener: ProvisionalCacheListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Drop every entry, timer and listener (test isolation / teardown). */
	reset(): void {
		for (const key of [...this.#entries.keys()]) {
			this.#drop(key);
		}
		this.#listeners.clear();
	}

	#drop(stableKey: string): boolean {
		const entry = this.#entries.get(stableKey);
		if (entry === undefined) {
			return false;
		}
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		this.#entries.delete(stableKey);
		return true;
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) {
			listener();
		}
	}
}

const cache = new UdevProvisionalCache();

/** The process-wide provisional-row store the wire producer reads. */
export function getUdevProvisionalCache(): UdevProvisionalCache {
	return cache;
}
