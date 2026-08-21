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
 * PURE derivation of one plug cycle's milestones from the three captured feeds.
 *
 * This is where a latency harness earns or loses its credibility, so the rules
 * are explicit rather than emergent:
 *
 * - **A row event is a TRANSITION BETWEEN CONSECUTIVE FRAMES, never a diff
 *   against a fixed snapshot.** This is the correctness core, and it was learned
 *   the hard way on the bench: with a fixed pre-cycle baseline, the frame a udev
 *   event CAUSES lands within a few milliseconds of the event itself, and the
 *   two timestamps come from DIFFERENT clocks (udev's monotonic header projected
 *   onto the epoch axis vs the WebSocket client's own receive time). So the
 *   causing frame could sort just BEFORE its own cause, get adopted as the
 *   baseline, and make the very change it carried invisible — measured on a real
 *   capture as a 3 ms removal in one cycle and an 11 s one in the next, from the
 *   same hardware doing the same thing. Comparing each frame with the one before
 *   it removes the whole class: a row that appears did so at the frame that first
 *   carried it, whatever the clocks say.
 * - **Every milestone is CAUSALLY ordered, not merely time-ordered.** Each one is
 *   searched for at or after the milestone it is measured from, so a stray event
 *   from a previous cycle cannot produce a flatteringly small span.
 * - **A milestone that was not observed stays absent.** Nothing is inferred,
 *   defaulted, or back-filled; the interval it feeds simply reports no sample. A
 *   pre-todo-18 build has no optimistic row at all, and the honest output for
 *   that is an empty column, not a zero.
 * - **The device under test is identified by its udev `ID_PATH`**, taken from the
 *   removal that the cycle itself caused. Matching the add back to that same
 *   ID_PATH is what keeps an unrelated USB event elsewhere on the bench from
 *   being scored as this cycle's re-enumeration.
 */

import type { CycleMilestones, MilestoneId } from "./latency-report.ts";
import { CLOCK_SKEW_TOLERANCE_MS } from "./latency-report.ts";
import type { BusctlSignal, ModemRowFacts } from "./latency-sources.ts";
import { mmIndexFromObjectPath } from "./latency-sources.ts";

/** A `status.modems` frame, stamped when the WebSocket client received it. */
export interface WsRowEvent {
	readonly epochMs: number;
	readonly rows: ReadonlyMap<string, ModemRowFacts>;
}

/** A udev event already projected onto the epoch axis. */
export interface UdevEpochEvent {
	readonly epochMs: number;
	readonly action: string;
	readonly devtype: string;
	readonly idPath: string | null;
}

/** The bounds and starting state of one cycle. */
export interface CycleWindow {
	readonly cycle: number;
	readonly startMs: number;
	readonly endMs: number;
	readonly preRows: ReadonlyMap<string, ModemRowFacts>;
	/**
	 * A window that never cycled a port.
	 *
	 * The property-propagation milestone is a STEADY-STATE property of a standing
	 * row, not a plug-cycle one — ModemManager emits its property signals on its
	 * own schedule — so measuring it must not require a detach. In such a window
	 * the absent attach/detach/export milestones are expected rather than
	 * findings, and reporting them as notes would bury the one real result.
	 */
	readonly observeOnly?: boolean;
}

/** One row appearing in, or vanishing from, the frame that first showed it. */
interface RowTransition {
	readonly epochMs: number;
	readonly key: string;
	readonly row: ModemRowFacts;
}

const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES = "org.freedesktop.DBus.Properties";

export function deriveCycleMilestones(
	window: CycleWindow,
	udevEvents: readonly UdevEpochEvent[],
	busctlSignals: readonly BusctlSignal[],
	wsEvents: readonly WsRowEvent[],
): CycleMilestones {
	const times: Partial<Record<MilestoneId, number>> = {};
	const notes: string[] = [];

	const inWindow = <T extends { epochMs: number }>(event: T): boolean =>
		event.epochMs >= window.startMs && event.epochMs <= window.endMs;

	const udev = udevEvents
		.filter(inWindow)
		.filter((event) => event.devtype === "usb_device" && event.idPath !== null);
	const bus = busctlSignals.filter(inWindow);
	const ws = wsEvents.filter(inWindow);

	const { appeared, vanished } = collectRowTransitions(window.preRows, ws);

	// ── detach ────────────────────────────────────────────────────────────────
	const note = (message: string): void => {
		if (!window.observeOnly) notes.push(message);
	};

	const removal = udev.find((event) => event.action === "remove");
	const idPath = removal?.idPath ?? null;
	if (removal) times.udev_remove = removal.epochMs;
	else note("no udev remove observed — the port may not have powered off");

	if (removal) {
		const gone = firstAtOrAfter(
			vanished,
			removal.epochMs,
			(transition) =>
				!transition.row.routerBacked && !transition.row.provisional,
		);
		if (gone) times.row_removed = gone.epochMs;
		else note("no row disappeared after the detach within the cycle window");
	}

	// ── attach ────────────────────────────────────────────────────────────────
	const attach = udev.find(
		(event) =>
			event.action === "add" &&
			(idPath === null || event.idPath === idPath) &&
			(removal === undefined || event.epochMs >= removal.epochMs),
	);
	if (attach) times.udev_add = attach.epochMs;
	else note("no udev add observed — the device did not re-enumerate");

	// ── ModemManager export ───────────────────────────────────────────────────
	const attachMs = attach?.epochMs ?? window.startMs;
	const exported = bus.find(
		(signal) =>
			signal.interfaceName === OBJECT_MANAGER &&
			signal.member === "InterfacesAdded" &&
			signal.epochMs >= attachMs &&
			signal.objectPath !== null &&
			mmIndexFromObjectPath(signal.objectPath) !== null,
	);
	const mmIndex =
		exported?.objectPath != null
			? mmIndexFromObjectPath(exported.objectPath)
			: null;
	if (exported) times.mm_export = exported.epochMs;
	else note("ModemManager never exported the device inside the window");

	// ── rows ──────────────────────────────────────────────────────────────────
	const provisional = firstAtOrAfter(
		appeared,
		attachMs,
		(transition) => transition.row.provisional,
	);
	if (provisional) times.row_provisional = provisional.epochMs;

	const authoritative = firstAtOrAfter(
		appeared,
		exported?.epochMs ?? attachMs,
		(transition) =>
			!transition.row.provisional &&
			!transition.row.routerBacked &&
			(mmIndex === null || transition.row.mmIndex === mmIndex),
	);
	if (authoritative) times.row_authoritative = authoritative.epochMs;
	else note("no authoritative row appeared inside the window");

	// ── steady-state property propagation ─────────────────────────────────────
	const propagation = findPropertyPropagation(
		bus,
		ws,
		authoritative?.epochMs ?? window.startMs,
	);
	if (propagation) {
		times.mm_properties_changed = propagation.signalMs;
		times.row_property_update = propagation.frameMs;
	} else {
		notes.push(
			"no PropertiesChanged produced a visible row change in the window",
		);
	}

	return { cycle: window.cycle, idPath, mmIndex, times, notes };
}

/**
 * Every row appearance and disappearance, each stamped with the frame that first
 * showed it. `preRows` is frame −1, so a row already standing when the cycle
 * opened is not reported as appearing.
 */
function collectRowTransitions(
	preRows: ReadonlyMap<string, ModemRowFacts>,
	ws: readonly WsRowEvent[],
): { appeared: RowTransition[]; vanished: RowTransition[] } {
	const appeared: RowTransition[] = [];
	const vanished: RowTransition[] = [];
	let previous = preRows;

	for (const event of ws) {
		for (const [key, row] of event.rows) {
			if (!previous.has(key))
				appeared.push({ epochMs: event.epochMs, key, row });
		}
		for (const [key, row] of previous) {
			if (!event.rows.has(key))
				vanished.push({ epochMs: event.epochMs, key, row });
		}
		previous = event.rows;
	}

	return { appeared, vanished };
}

/**
 * The first matching transition at or after `anchorMs`.
 *
 * The anchor is relaxed by `CLOCK_SKEW_TOLERANCE_MS` because the anchor and the
 * frame are stamped by different clocks (see the module note). The tolerance is
 * orders of magnitude smaller than the spacing between cycles, so it can never
 * admit a neighbouring cycle's transition — only the frame the anchor caused.
 */
function firstAtOrAfter(
	transitions: readonly RowTransition[],
	anchorMs: number,
	matches: (transition: RowTransition) => boolean,
): RowTransition | undefined {
	return transitions.find(
		(transition) =>
			transition.epochMs >= anchorMs - CLOCK_SKEW_TOLERANCE_MS &&
			matches(transition),
	);
}

/**
 * The first visible row change, paired with the signal that PROXIMATELY caused it.
 *
 * The search runs change-first, not signal-first, and the direction matters.
 * ModemManager emits property signals for every modem it manages and most of
 * them change nothing the wire projects (bearer counters, internal state the row
 * does not carry), so walking signals forward pairs the FIRST — usually inert —
 * signal with a change some later signal actually produced, and reports that
 * whole dead interval as propagation latency. Anchoring on the change and taking
 * the LATEST signal at or before it names the proximate cause instead.
 */
function findPropertyPropagation(
	bus: readonly BusctlSignal[],
	ws: readonly WsRowEvent[],
	sinceMs: number,
): { signalMs: number; frameMs: number } | undefined {
	const propertySignals = bus.filter(
		(signal) =>
			signal.interfaceName === PROPERTIES &&
			signal.member === "PropertiesChanged" &&
			mmIndexFromObjectPath(signal.senderPath) !== null,
	);
	if (propertySignals.length === 0) return undefined;

	const fingerprints = new Map<number, string>();

	for (const event of ws) {
		for (const row of event.rows.values()) {
			if (row.mmIndex === null) continue;
			const previous = fingerprints.get(row.mmIndex);
			fingerprints.set(row.mmIndex, row.fingerprint);
			if (previous === undefined || previous === row.fingerprint) continue;
			if (event.epochMs < sinceMs) continue;

			const cause = lastAtOrBefore(propertySignals, row.mmIndex, event.epochMs);
			if (cause !== undefined) {
				return { signalMs: cause, frameMs: event.epochMs };
			}
		}
	}
	return undefined;
}

/** The latest `PropertiesChanged` for `mmIndex` at or before `frameMs`. */
function lastAtOrBefore(
	propertySignals: readonly BusctlSignal[],
	mmIndex: number,
	frameMs: number,
): number | undefined {
	let latest: number | undefined;
	for (const signal of propertySignals) {
		if (mmIndexFromObjectPath(signal.senderPath) !== mmIndex) continue;
		if (signal.epochMs > frameMs + CLOCK_SKEW_TOLERANCE_MS) break;
		latest = signal.epochMs;
	}
	return latest;
}
