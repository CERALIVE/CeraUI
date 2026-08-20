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
 * PURE readers for the three plug-to-UI milestone sources.
 *
 * Every milestone the latency harness reports has to sit on ONE time axis, and
 * two of the three sources are read through a pipe — which is exactly where a
 * naive harness goes wrong. `busctl monitor` block-buffers when its stdout is
 * not a tty, so a whole cycle's signals can land in the reader in a single
 * burst tens of seconds after the events happened; timestamping at READ time
 * would have attributed all of them to the moment the buffer drained. That was
 * measured on the bench, not assumed.
 *
 * So NEITHER pipe source is read-time stamped. Both tools already emit their
 * own clock and both are used:
 *
 * - `udevadm monitor` prints `UDEV  [14311.245323] add …` — CLOCK_MONOTONIC
 *   seconds since boot, converted here to epoch ms by a caller-supplied boot
 *   offset (see `udevEventEpochMs`).
 * - `busctl --system monitor` prints `Timestamp="Tue 2026-08-18 00:51:10.462655
 *   UTC"` on every signal header — the bus's own CLOCK_REALTIME microseconds.
 *
 * The WebSocket source is the only one stamped on arrival, and legitimately so:
 * it is read in-process with no intermediate buffering, and "when the row
 * reached a UI client" is precisely a receive-time fact.
 *
 * Everything here is a pure function over captured text so the harness's own
 * arithmetic is unit-testable off-board.
 */

/** One decoded `udevadm monitor --property` event block. */
export interface UdevMonitorEvent {
	/** `ACTION=` — the property, never the header word. */
	readonly action: string;
	/** CLOCK_MONOTONIC seconds from the header, or `null` if unparseable. */
	readonly monotonicSec: number | null;
	readonly properties: ReadonlyMap<string, string>;
}

/** One decoded `busctl --system monitor` signal record. */
export interface BusctlSignal {
	/** Epoch ms from the record's own `Timestamp="…"` header field. */
	readonly epochMs: number;
	readonly interfaceName: string;
	readonly member: string;
	/** The first `OBJECT_PATH "…"` in the body, when the signal carries one. */
	readonly objectPath: string | null;
	/** `Path=` from the header — the emitting object. */
	readonly senderPath: string;
}

const UDEV_HEADER = /^(?:UDEV|KERNEL)\s+\[(\d+\.\d+)]\s+(\S+)\s/;
const BUSCTL_TIMESTAMP =
	/Timestamp="(?:\S+\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\.(\d+)\s+UTC"/;
const BUSCTL_OBJECT_PATH = /^\s*OBJECT_PATH\s+"([^"]+)"/;

/**
 * Decode a whole `udevadm monitor --property --udev` capture.
 *
 * Blocks are separated by a blank line: a header line then `KEY=VALUE` lines.
 * The ACTION is read from the property, not the header word, for the same
 * reason the production reader does it (`udev-cellular-events.ts`): header
 * spacing is a display detail, the properties are the contract.
 */
export function parseUdevMonitorEvents(
	capture: string,
): readonly UdevMonitorEvent[] {
	const events: UdevMonitorEvent[] = [];

	for (const block of capture.split(/\n\s*\n/)) {
		const lines = block.split("\n");
		const properties = new Map<string, string>();
		let monotonicSec: number | null = null;

		for (const line of lines) {
			const header = UDEV_HEADER.exec(line);
			if (header?.[1] !== undefined) {
				monotonicSec = Number.parseFloat(header[1]);
				continue;
			}
			const eq = line.indexOf("=");
			if (eq <= 0) continue;
			const key = line.slice(0, eq).trim();
			// A property key is a bare token; anything with whitespace is a header
			// or a wrapped value line, not a `KEY=VALUE`.
			if (key.length === 0 || /\s/.test(key)) continue;
			properties.set(key, line.slice(eq + 1));
		}

		const action = properties.get("ACTION");
		if (action === undefined) continue;
		events.push({ action, monotonicSec, properties });
	}

	return events;
}

/**
 * Epoch ms for a udev event, given the boot instant on the epoch axis.
 *
 * `null` when the header timestamp was unreadable — the caller drops the
 * milestone rather than substituting a read-time guess, because a guessed
 * timestamp here is indistinguishable from a real measurement downstream.
 */
export function udevEventEpochMs(
	event: UdevMonitorEvent,
	bootEpochMs: number,
): number | null {
	if (event.monotonicSec === null) return null;
	return bootEpochMs + event.monotonicSec * 1000;
}

/** Parse a `busctl monitor` `Timestamp="…"` header field to epoch ms. */
export function parseBusctlTimestamp(line: string): number | null {
	const match = BUSCTL_TIMESTAMP.exec(line);
	if (!match) return null;
	const [, date, time, fraction] = match;
	if (date === undefined || time === undefined || fraction === undefined) {
		return null;
	}
	const seconds = Date.parse(`${date}T${time}Z`);
	if (Number.isNaN(seconds)) return null;
	// busctl prints microseconds; keep sub-ms precision out of the epoch value
	// rather than rounding it away silently.
	return (
		seconds + Number.parseInt(fraction.slice(0, 6).padEnd(6, "0"), 10) / 1000
	);
}

/**
 * Decode a whole `busctl --system monitor <service>` capture.
 *
 * Only `Type=signal` records are kept — method calls and replies are noise for
 * a milestone timeline. A record whose header carries no parseable timestamp is
 * DROPPED rather than read-time stamped, for the buffering reason in the module
 * note above.
 *
 * The record boundary is EVERY header (`Type=…  Endian=…`), not just the signal
 * ones. Ending the boundary at `Type=signal` was measured to mis-attribute the
 * `Member=` of a following `method_call` — a `GetManagedObjects` call MM makes
 * constantly — onto the still-open signal, silently renaming every
 * `InterfacesAdded` in the capture.
 */
export function parseBusctlSignals(capture: string): readonly BusctlSignal[] {
	const signals: BusctlSignal[] = [];
	let pending: {
		epochMs: number;
		interfaceName: string;
		member: string;
		senderPath: string;
		objectPath: string | null;
	} | null = null;

	const flush = (): void => {
		if (pending && pending.member.length > 0) {
			signals.push({ ...pending });
		}
		pending = null;
	};

	for (const line of capture.split("\n")) {
		if (line.includes("Type=") && line.includes("Endian=")) {
			flush();
			const epochMs = parseBusctlTimestamp(line);
			if (epochMs === null || !line.includes("Type=signal")) continue;
			pending = {
				epochMs,
				interfaceName: "",
				member: "",
				senderPath: "",
				objectPath: null,
			};
			continue;
		}
		if (!pending) continue;

		if (pending.member.length === 0 && line.includes("Member=")) {
			pending.member = fieldValue(line, "Member=");
			pending.interfaceName = fieldValue(line, "Interface=");
			pending.senderPath = fieldValue(line, "Path=");
			continue;
		}
		if (pending.objectPath === null) {
			const objectPath = BUSCTL_OBJECT_PATH.exec(line);
			if (objectPath?.[1] !== undefined) {
				pending.objectPath = objectPath[1];
			}
		}
	}
	flush();

	return signals;
}

/** Read a `Key=value` field out of a whitespace-separated busctl header line. */
function fieldValue(line: string, key: string): string {
	const at = line.indexOf(key);
	if (at < 0) return "";
	const rest = line.slice(at + key.length);
	const end = rest.search(/\s/);
	return end < 0 ? rest : rest.slice(0, end);
}

/** The wire token todo 18 stamps on an optimistic, not-yet-authoritative row. */
export const PROVISIONAL_AVAILABILITY_REASON = "modem_initializing";

/** One `status.modems` row, reduced to what a latency milestone needs. */
export interface ModemRowFacts {
	/** The row's key on the wire (`status.modems` object key). */
	readonly wireKey: string;
	/** Todo 18's optimistic row marker. */
	readonly provisional: boolean;
	/** A router-dongle row — never an MM export, so never an MM milestone. */
	readonly routerBacked: boolean;
	/** `/org/freedesktop/ModemManager1/Modem/N` index, when the row is an MM row. */
	readonly mmIndex: number | null;
	/** Value fingerprint, for detecting a property update on a standing row. */
	readonly fingerprint: string;
}

/**
 * Reduce a `status.modems` payload to the row facts the milestones key on.
 *
 * Identity: `stable_key` when the build emits one, else the wire key. The
 * pre-todo-17/18 baseline build emits NO `stable_key` on any row (verified on
 * the bench), so falling back to the wire key is what makes the SAME harness
 * measure both phases — and it is sound here because a replugged modem is
 * re-exported by MM under a FRESH index, so the wire key of a returning device
 * differs from the one it had before, which is precisely the appearance the
 * set-diff is looking for.
 */
export function snapshotModemRows(
	payload: unknown,
): ReadonlyMap<string, ModemRowFacts> {
	const rows = new Map<string, ModemRowFacts>();
	if (typeof payload !== "object" || payload === null) return rows;

	for (const [wireKey, value] of Object.entries(
		payload as Record<string, unknown>,
	)) {
		if (typeof value !== "object" || value === null) continue;
		const row = value as Record<string, unknown>;

		const deviceClass =
			typeof row.device_class === "string" ? row.device_class : "";
		const routerBacked = deviceClass.startsWith("router-");
		const stableKey =
			typeof row.stable_key === "string" && row.stable_key.length > 0
				? row.stable_key
				: null;
		const mmIndex = routerBacked ? null : parseWireKeyAsMmIndex(wireKey);

		rows.set(stableKey ?? wireKey, {
			wireKey,
			provisional: row.availability_reason === PROVISIONAL_AVAILABILITY_REASON,
			routerBacked,
			mmIndex,
			fingerprint: JSON.stringify(row),
		});
	}

	return rows;
}

/**
 * The MM object index behind an MM row's wire key.
 *
 * The projection allocates SYNTHETIC ids from 1000 up for rows that have no MM
 * object (`modem-wire-projection.ts`), so only a sub-1000 numeric key can be an
 * MM index. Anything else answers `null` rather than inventing a correlation.
 */
export function parseWireKeyAsMmIndex(wireKey: string): number | null {
	if (!/^\d+$/.test(wireKey)) return null;
	const index = Number.parseInt(wireKey, 10);
	return index >= 1000 ? null : index;
}

/** The MM object index in `/org/freedesktop/ModemManager1/Modem/N`, or `null`. */
export function mmIndexFromObjectPath(objectPath: string): number | null {
	const match = /\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)$/.exec(
		objectPath,
	);
	if (match?.[1] === undefined) return null;
	return Number.parseInt(match[1], 10);
}
