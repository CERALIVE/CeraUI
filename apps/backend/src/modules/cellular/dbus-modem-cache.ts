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
 * The observation cache the wire producer's `readDbusViews()` actually serves.
 *
 * It owns three things the observer deliberately does not:
 *
 *  1. AUTHORITY. Which of `initializing / authoritative / settling /
 *     retained-stale / demoted` the D-Bus source is in, and therefore whether
 *     the wire projects D-Bus rows or falls back to mmcli.
 *  2. THE MM-RESTART SETTLE GUARD. A ModemManager restart resnapshots ~18 ms
 *     after the new owner appears, before the daemon has re-probed a single
 *     port, and legitimately answers `modemCount: 0` — measured on real
 *     hardware, todo 16 gate 4. Publishing that verbatim blanks the operator's
 *     modem list for the ~20 s the roster takes to refill. So a new epoch merges
 *     into the retained roster and does not gain authority until it has refilled
 *     or {@link EPOCH_SETTLE_MS} has passed.
 *  3. PUBLICATION BOUNDS. Structural change propagates immediately; a
 *     signal/operator burst coalesces on a {@link COALESCE_MS} trailing timer.
 *
 * The full written contract — including WHY `bus-error` falls back to mmcli and
 * `source-unavailable` must not — is `docs/DBUS-OBSERVATION-CONTRACT.md`.
 */

import type { DbusModemView } from "../modems/modem-wire-adapters.ts";

/** Trailing coalesce window for signal/operator bursts (plan band: 100-250 ms). */
export const COALESCE_MS = 150;

/** Above the ~20 s post-restart roster refill measured on the reference board. */
export const EPOCH_SETTLE_MS = 25_000;

export const REASON_MM_RESTARTING = "mm-restarting";
export const REASON_MM_UNAVAILABLE = "mm-unavailable";

export type DbusCacheAuthority =
	| "initializing"
	| "authoritative"
	| "settling"
	| "retained-stale"
	| "demoted";

/** Why an observation could not produce an authoritative list (observer vocabulary). */
export type DbusFailureReason =
	| "not-started"
	| "source-unavailable"
	| "bus-error";

export type DbusCacheListener = () => void;

interface CacheState {
	authority: DbusCacheAuthority;
	epoch: string | undefined;
	settleDeadlineMs: number;
	retainedCount: number;
	views: readonly DbusModemView[];
	published: readonly DbusModemView[];
}

/** Cross-epoch identity: the `ID_PATH` anchor, else a within-epoch-only fallback. */
function viewKey(view: DbusModemView): string {
	return view.idPath !== undefined && view.idPath.length > 0
		? `id:${view.idPath}`
		: `mm:${view.runtimeId}`;
}

function isCrossEpochKey(key: string): boolean {
	return key.startsWith("id:");
}

function withReason(view: DbusModemView, reason: string): DbusModemView {
	return view.availabilityReason === reason
		? view
		: { ...view, availabilityReason: reason };
}

/** Fields whose change an operator must see on the next frame, not 150 ms later. */
const STRUCTURAL_FIELDS = [
	"mmState",
	"ifname",
	"simLockRequired",
	"availabilityReason",
	"activeNetworkType",
	"scanning",
] as const satisfies readonly (keyof DbusModemView)[];

function isStructuralChange(
	previous: readonly DbusModemView[],
	next: readonly DbusModemView[],
): boolean {
	if (previous.length !== next.length) {
		return true;
	}
	const before = new Map(previous.map((view) => [viewKey(view), view]));
	for (const view of next) {
		const old = before.get(viewKey(view));
		if (old === undefined) {
			return true;
		}
		if (old.registration.status !== view.registration.status) {
			return true;
		}
		for (const field of STRUCTURAL_FIELDS) {
			if (old[field] !== view[field]) {
				return true;
			}
		}
	}
	return false;
}

function sameViews(
	previous: readonly DbusModemView[],
	next: readonly DbusModemView[],
): boolean {
	return (
		previous.length === next.length &&
		previous.every((view, index) => {
			const other = next[index];
			return (
				other !== undefined && JSON.stringify(view) === JSON.stringify(other)
			);
		})
	);
}

/**
 * The single observation cache instance.
 *
 * A class rather than module-level state so a test can own an isolated
 * instance, while the module singleton below keeps the wire producer's sync
 * `readDbusViews()` seam unchanged.
 */
export class DbusModemCache {
	readonly #listeners = new Set<DbusCacheListener>();
	#state: CacheState = {
		authority: "initializing",
		epoch: undefined,
		settleDeadlineMs: 0,
		retainedCount: 0,
		views: [],
		published: [],
	};
	#coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	#now: () => number = () => Date.now();

	/** Test seam: a deterministic clock for the settle and tombstone windows. */
	setClock(now: (() => number) | null): void {
		this.#now = now ?? (() => Date.now());
	}

	authority(): DbusCacheAuthority {
		return this.#state.authority;
	}

	/**
	 * What the wire producer serves.
	 *
	 * Empty means "mmcli is authoritative right now" — either nothing has been
	 * observed yet or the D-Bus source demoted itself below mmcli.
	 */
	readViews(): readonly DbusModemView[] {
		return this.#state.published;
	}

	subscribe(listener: DbusCacheListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * A successful current-epoch snapshot, already folded to wire views.
	 *
	 * REMOVAL LIVES HERE AND NOWHERE ELSE: a modem disappears exactly when an
	 * authoritative (non-settling) snapshot omits it, and it is dropped outright.
	 * There is deliberately NO tombstone map — a removed row leaves `views`, so
	 * the settling merge below structurally cannot re-inject it, and a removal
	 * record would be code that can never run. A re-plugged device comes straight
	 * back on the next snapshot that reports it.
	 */
	applySnapshot(epoch: string, views: readonly DbusModemView[]): void {
		const state = this.#state;
		if (epoch !== state.epoch) {
			this.#beginEpoch(epoch);
		}
		if (this.#state.authority === "settling") {
			this.#applySettling(views);
			return;
		}
		this.#commit(views, "authoritative");
	}

	/**
	 * The observation failed. The two reasons demand OPPOSITE responses and are
	 * separated here rather than folded into one "unavailable" state:
	 *
	 *  - `bus-error` — MM is alive and answerable, our client failed. mmcli is a
	 *    real second opinion, so demote below it (serve nothing).
	 *  - `source-unavailable` — the MM bus name has no owner. mmcli talks to the
	 *    SAME dead daemon, so there is no backstop: retain the rows, mark them,
	 *    and make no fallback-healthy claim.
	 */
	applyFailure(reason: DbusFailureReason): void {
		if (reason === "bus-error") {
			this.#commit([], "demoted");
			return;
		}
		const retained = this.#state.views.map((view) =>
			withReason(view, REASON_MM_UNAVAILABLE),
		);
		this.#state = { ...this.#state, epoch: undefined };
		this.#commit(retained, retained.length > 0 ? "retained-stale" : "demoted");
	}

	/** Drop every cache, timer and listener. */
	reset(): void {
		this.#cancelCoalesce();
		this.#listeners.clear();
		this.#state = {
			authority: "initializing",
			epoch: undefined,
			settleDeadlineMs: 0,
			retainedCount: 0,
			views: [],
			published: [],
		};
	}

	#beginEpoch(epoch: string): void {
		const retained = this.#state.views;
		const isFirstEpoch = this.#state.authority === "initializing";
		this.#state = {
			authority:
				isFirstEpoch || retained.length === 0 ? "authoritative" : "settling",
			epoch,
			settleDeadlineMs: this.#now() + EPOCH_SETTLE_MS,
			retainedCount: retained.length,
			views: retained,
			published: this.#state.published,
		};
	}

	/**
	 * Merge a new epoch's partial roster over the retained one.
	 *
	 * Rows the new owner has re-probed go live; rows it has not yet re-probed are
	 * KEPT and marked, which is the whole point — this is the branch that stops
	 * the `modemCount: 0` resnapshot from blanking the operator's list.
	 */
	#applySettling(views: readonly DbusModemView[]): void {
		const settled =
			views.length >= this.#state.retainedCount ||
			this.#now() >= this.#state.settleDeadlineMs;
		if (settled) {
			this.#commit(views, "authoritative");
			return;
		}
		const freshKeys = new Set(views.map(viewKey));
		// A row is carried only when it can be matched ACROSS an epoch. An MM
		// index renumbers on every restart (todo 16 measured `11,13,14,15` →
		// `0,1,2,3`), so an `mm:<runtimeId>` row carried into a new epoch would be
		// a coincidence, not a match.
		const carried = this.#state.views.filter((view) => {
			const key = viewKey(view);
			return isCrossEpochKey(key) && !freshKeys.has(key);
		});
		const merged = [
			...views,
			...carried.map((view) => withReason(view, REASON_MM_RESTARTING)),
		];
		this.#state = { ...this.#state, views: merged };
		this.#publish(merged);
	}

	#commit(
		views: readonly DbusModemView[],
		authority: DbusCacheAuthority,
	): void {
		this.#state = {
			...this.#state,
			authority,
			views,
			retainedCount: views.length,
		};
		this.#publish(views);
	}

	#publish(views: readonly DbusModemView[]): void {
		const previous = this.#state.published;
		if (sameViews(previous, views)) {
			return;
		}
		if (isStructuralChange(previous, views)) {
			this.#cancelCoalesce();
			this.#state = { ...this.#state, published: views };
			this.#notify();
			return;
		}
		this.#state = { ...this.#state, published: views };
		if (this.#coalesceTimer !== undefined) {
			return;
		}
		this.#coalesceTimer = setTimeout(() => {
			this.#coalesceTimer = undefined;
			this.#notify();
		}, COALESCE_MS);
		this.#coalesceTimer.unref?.();
	}

	#cancelCoalesce(): void {
		if (this.#coalesceTimer !== undefined) {
			clearTimeout(this.#coalesceTimer);
			this.#coalesceTimer = undefined;
		}
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) {
			listener();
		}
	}
}

const cache = new DbusModemCache();

/** The process-wide observation cache the wire producer reads. */
export function getDbusModemCache(): DbusModemCache {
	return cache;
}
