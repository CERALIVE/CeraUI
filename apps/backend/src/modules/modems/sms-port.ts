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
 * The SMS-normalization seam: `@ceralive/modem-control`'s read-only SMS port.
 *
 * WHY IT IS A STATIC IMPORT NOW. This resolution used to be a lazy
 * `import("@ceralive/modem-control")` behind a structural probe, because the
 * port landed in modem-stack AFTER the version `package.json` pinned and a
 * static import of a symbol the pinned release does not export fails the BUILD
 * rather than degrading. `package.json` now pins `1.1.0` EXACTLY, which
 * publishes the whole port, so the probe has nothing left to discover: the
 * import is enforced by `tsc` at build time and by `bun install` at install
 * time, which is strictly stronger than a runtime `typeof === "function"` check
 * that could only ever report the gap after the fact.
 *
 * WHY THE LEGACY PARSERS STAY. They are no longer a fallback — nothing can fall
 * back to them, because the port always resolves. They remain the PARITY ORACLE:
 * `modem-sms-port-parity.test.ts` pins their output against the exact golden
 * values modem-stack's own `sms/parse.test.ts` pins for the port, and its last
 * case now drives BOTH implementations through `readSmsInbox` and asserts one
 * inbox, so either side drifting reddens a test on both.
 *
 * THE SEAM IS NORMALIZATION ONLY, AND DELIBERATELY SO. The transport stays
 * `mmcli` — a client of the SAME ModemManager daemon the port's D-Bus adapter
 * talks to, already proven on the bench board, and adding ZERO modem-control
 * surface. Moving the transport to the port's `Added`/`Deleted` observation is a
 * separate change that needs a live receive drill to certify, and that drill is
 * blocked (no bench modem has an SMS-capable registered SIM).
 */

import {
	classifySmsFailure,
	parseSmsListOutput,
	parseSmsRecordOutput,
	SMS_INBOX_CAP,
	selectReadablePaths,
	sortAndCapSms,
} from "@ceralive/modem-control";

import type { SmsMessage, SmsReadRefusal, SmsState } from "./mmcli-sms.ts";

/** The normalization surface `readSmsInbox` drives, whoever provides it. */
export interface SmsNormalizer {
	/** Which implementation answered — for the log line and for tests. */
	readonly source: "port" | "legacy";
	readonly cap: number;
	parseList(raw: string): SmsNormalizeResult<string[]>;
	parseRecord(raw: string): SmsNormalizeResult<SmsMessage>;
	classifyFailure(description: string): SmsReadRefusal;
	selectPaths(paths: readonly string[]): string[];
	sortAndCap(messages: readonly SmsMessage[]): SmsMessage[];
}

/**
 * A normalization outcome. `detail` carries KEY NAMES and never content — the
 * content-free property is a contract of both implementations, so the seam
 * cannot be the place it is lost.
 */
export type SmsNormalizeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string; readonly detail: string };

/**
 * The package's port, expressed as this seam's normalizer.
 *
 * The cap is the PORT's own `SMS_INBOX_CAP` and is passed explicitly to both
 * bounded calls, so the read cap can never be one value in the selector and a
 * different one in the sort.
 */
export const smsPortNormalizer: SmsNormalizer = {
	source: "port",
	cap: SMS_INBOX_CAP,
	parseList: (raw) => parseSmsListOutput(raw),
	parseRecord: (raw) => parseSmsRecordOutput(raw),
	classifyFailure: (description) => classifySmsFailure(description),
	selectPaths: (paths) => selectReadablePaths(paths, SMS_INBOX_CAP),
	sortAndCap: (messages) => sortAndCapSms(messages, SMS_INBOX_CAP),
};

let override: SmsNormalizer | undefined;

/**
 * The normalizer `readSmsInbox` drives.
 *
 * There is no resolution left to do and therefore no failure mode to degrade
 * from — the port is a static import of an exactly-pinned dependency, so it is
 * present or the build does not exist. The test override is the only thing that
 * can answer differently.
 */
export function resolveSmsNormalizer(): SmsNormalizer {
	return override ?? smsPortNormalizer;
}

/** Test seam (the `set*Runner` convention). `null` restores the real port. */
export function setSmsNormalizerForTest(
	normalizer: SmsNormalizer | null,
): void {
	override = normalizer ?? undefined;
}

export type { SmsState };
