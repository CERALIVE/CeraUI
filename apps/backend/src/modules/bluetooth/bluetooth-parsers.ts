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
 * NAMED parsers and validators for everything this module reads back (S2).
 *
 * PURE — no spawn, no bus, no clock. Every function answers a discriminated
 * {@link ParseResult}: a caller can never mistake "the tool said something we do
 * not understand" for a value. That distinction is the whole point here, because
 * both of the CLI reads on this path have a failure mode that LOOKS like a
 * legitimate answer:
 *
 *  - `systemctl is-enabled bluealsad.service` (the wrong unit name) prints
 *    NOTHING on stdout and exits non-zero. An inline `stdout.trim() === "enabled"`
 *    reads that as "disabled" and cheerfully reports a healthy reconcile for a
 *    unit that does not exist.
 *  - `bluealsad --help` on a build with no wideband support prints a help text
 *    with no `msbc` in it — indistinguishable, to a bare `includes("msbc")`,
 *    from a binary that is missing entirely and printed an error instead.
 *
 * So the empty/unrecognised cases are TYPED, and the callers act on the type.
 */

import type { DbusValue } from "@ceralive/modem-control/transport";

/** Why a named parser refused to answer. */
export type ParseFailureKind =
	| "empty-output"
	| "unrecognized-state"
	| "unrecognized-help";

export interface ParseFailure {
	readonly ok: false;
	readonly kind: ParseFailureKind;
	/** The offending text, trimmed and length-capped — never a secret on this path. */
	readonly detail: string;
}

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| ParseFailure;

const DETAIL_CAP = 120;

function fail(kind: ParseFailureKind, raw: string): ParseFailure {
	return { ok: false, kind, detail: raw.trim().slice(0, DETAIL_CAP) };
}

// ─── systemctl ────────────────────────────────────────────────────────────────

/** The `systemctl is-active` vocabulary this build recognises. */
export const UNIT_ACTIVE_STATES = [
	"active",
	"reloading",
	"inactive",
	"failed",
	"activating",
	"deactivating",
	"unknown",
] as const;

export type UnitActiveState = (typeof UNIT_ACTIVE_STATES)[number];

/**
 * Parse `systemctl is-active <unit>` output.
 *
 * A missing unit prints `inactive` (or `unknown`) with a non-zero exit, both of
 * which are recognised values — so the CALLER must not treat a non-zero exit as
 * a parse problem. Empty stdout, however, is not an answer.
 */
export function parseUnitActiveState(
	stdout: string,
): ParseResult<UnitActiveState> {
	const value = stdout.trim().split(/\s+/)[0] ?? "";
	if (value.length === 0) return fail("empty-output", stdout);
	const known = UNIT_ACTIVE_STATES.find((s) => s === value);
	return known === undefined
		? fail("unrecognized-state", stdout)
		: { ok: true, value: known };
}

/** The `systemctl is-enabled` vocabulary this build recognises. */
export const UNIT_ENABLED_STATES = [
	"enabled",
	"enabled-runtime",
	"linked",
	"linked-runtime",
	"alias",
	"masked",
	"masked-runtime",
	"static",
	"indirect",
	"disabled",
	"generated",
	"transient",
	"bad",
] as const;

export type UnitEnabledState = (typeof UNIT_ENABLED_STATES)[number];

/**
 * Parse `systemctl is-enabled <unit>` output.
 *
 * THE EMPTY CASE IS THE ONE THAT MATTERS: a unit systemd cannot find prints
 * nothing at all on stdout (the "Failed to get unit file state" line goes to
 * stderr), so an inline compare would silently classify a typo'd unit name as
 * "not enabled" and the reconciler would report success forever. `empty-output`
 * is how the wrong-unit-name defect surfaces.
 */
export function parseUnitEnabledState(
	stdout: string,
): ParseResult<UnitEnabledState> {
	const value = stdout.trim().split(/\s+/)[0] ?? "";
	if (value.length === 0) return fail("empty-output", stdout);
	const known = UNIT_ENABLED_STATES.find((s) => s === value);
	return known === undefined
		? fail("unrecognized-state", stdout)
		: { ok: true, value: known };
}

/** Whether an `is-enabled` reading means "systemd will start this at boot". */
export function isPersistentlyEnabled(state: UnitEnabledState): boolean {
	return (
		state === "enabled" || state === "enabled-runtime" || state === "alias"
	);
}

/** Whether an `is-active` reading means "this unit is running right now". */
export function isRunning(state: UnitActiveState): boolean {
	return state === "active" || state === "reloading";
}

// ─── BlueALSA capability probe ────────────────────────────────────────────────

export interface BluealsaHelpCapabilities {
	/** The build advertises the wideband-speech codec. PROBED, never assumed. */
	readonly msbc: boolean;
	/** The build accepts `-c/--codec` at all (mSBC is selected through it). */
	readonly codecFlag: boolean;
}

/**
 * Parse a BlueALSA daemon `--help` text into the capabilities we act on.
 *
 * Recognition is gated on the help text actually LOOKING like BlueALSA's — it
 * must offer the `--profile` option, which every bluez-alsa release has carried.
 * Anything else (a shell's "command not found", a different binary that happens
 * to be on PATH, a truncated read) answers `unrecognized-help` and the caller
 * ships the profile arguments WITHOUT a codec flag rather than guessing.
 */
export function parseBluealsaHelp(
	helpText: string,
): ParseResult<BluealsaHelpCapabilities> {
	const text = helpText.trim();
	if (text.length === 0) return fail("empty-output", helpText);
	if (!/--profile\b/.test(text)) return fail("unrecognized-help", helpText);

	return {
		ok: true,
		value: {
			msbc: /\bmsbc\b/i.test(text),
			codecFlag: /--codec\b/.test(text),
		},
	};
}

// ─── D-Bus value validators ───────────────────────────────────────────────────

/**
 * A boolean-typed D-Bus property, or `undefined` when absent / not a boolean.
 *
 * The package's own `stringProp`/`numberProp` cover the other two shapes; there
 * is no `boolProp` upstream, so this is the one missing accessor rather than a
 * second decode layer. Nothing here coerces: a `0`/`"false"` answers `undefined`
 * so a drifted property type is visible instead of silently falsy.
 */
export function asBoolean(value: DbusValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * A string-array (`as`) D-Bus property. An EMPTY array answers `[]` — the device
 * saying "none" — which is a different fact from an absent property
 * (`undefined`). Non-string members are dropped, never coerced.
 */
export function asStringArray(
	value: DbusValue | undefined,
): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === "string");
}

/**
 * A battery percentage (`Battery1.Percentage`, a `y` byte) clamped to 0-100.
 *
 * Out-of-range or non-integral readings answer `undefined` rather than being
 * clamped into a plausible-looking number: a battery level that is wrong is
 * worse than one that is absent.
 */
export function asBatteryPercentage(
	value: DbusValue | undefined,
): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= 0 && value <= 100 ? value : undefined;
}

/** A BlueZ object path shape (`/org/bluez/hci0/dev_AA_BB_...`). */
const OBJECT_PATH_RE = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;

/** Whether a string is a well-formed D-Bus object path. */
export function isObjectPath(value: unknown): value is string {
	return typeof value === "string" && OBJECT_PATH_RE.test(value);
}

/**
 * The adapter path that OWNS a device path (`/org/bluez/hci0/dev_…` →
 * `/org/bluez/hci0`), or `undefined` when the path is not a device under an
 * adapter. The per-adapter lock keys on this, so a malformed path must not
 * resolve to a neighbouring adapter.
 */
export function adapterPathOf(devicePath: string): string | undefined {
	if (!isObjectPath(devicePath)) return undefined;
	const match = /^(\/org\/bluez\/[A-Za-z0-9_]+)\/dev_[A-Za-z0-9_]+$/.exec(
		devicePath,
	);
	return match?.[1];
}
