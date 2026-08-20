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
 * The SMS-normalization seam: `@ceralive/modem-control`'s read-only SMS port
 * when the pinned package carries it, this backend's own parsers when it does
 * not.
 *
 * WHY A SEAM RATHER THAN AN IMPORT. The port landed in modem-stack AFTER the
 * version `package.json` pins, and a static import of a symbol the pinned
 * release does not export fails the BUILD rather than degrading. This is the
 * same lazy, structurally-probed resolution `usage-policy.ts` uses for
 * `setUsagePolicy`, `modem-wire-producer.ts` uses for `createUsbEnumerator`, and
 * `hardware-kind.ts` uses for the Zod-stripped `platform.hardware_kind`.
 *
 * WHY THE LEGACY PARSERS STAY. They are not a second opinion — they are the
 * PARITY ORACLE. `mmcli-sms.parity.test.ts` pins their output against the exact
 * golden values modem-stack's own `sms/parse.test.ts` pins for the port, so
 * either side drifting reddens a test on both. Removing them is the LAST step of
 * migrate-then-remove and is gated on the pin actually carrying the port, not on
 * this seam existing.
 *
 * THE SEAM IS NORMALIZATION ONLY, AND DELIBERATELY SO. The transport stays
 * `mmcli` — a client of the SAME ModemManager daemon the port's D-Bus adapter
 * talks to, already proven on the bench board, and adding ZERO modem-control
 * surface. Moving the transport to the port's `Added`/`Deleted` observation is a
 * separate change that needs a live receive drill to certify, and that drill is
 * blocked (no bench modem has an SMS-capable registered SIM).
 */

import { logger } from "../../helpers/logger.ts";
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

/** The shape the pinned package must expose before it can be adopted. */
interface SmsPortModule {
	readonly parseSmsListOutput: (raw: string) => SmsNormalizeResult<string[]>;
	readonly parseSmsRecordOutput: (
		raw: string,
	) => SmsNormalizeResult<SmsMessage>;
	readonly classifySmsFailure: (description: string) => SmsReadRefusal;
	readonly selectReadablePaths: (
		paths: readonly string[],
		cap?: number,
	) => string[];
	readonly sortAndCapSms: (
		messages: readonly SmsMessage[],
		cap?: number,
	) => SmsMessage[];
	readonly SMS_INBOX_CAP: number;
}

const isFn = (value: unknown): value is (...args: never[]) => unknown =>
	typeof value === "function";

/**
 * Every member must be present before the port is used. A partial match is a
 * package mid-migration, and half-adopting it would mean two implementations
 * answering different halves of one inbox read.
 */
function asSmsPort(loaded: unknown): SmsPortModule | undefined {
	if (typeof loaded !== "object" || loaded === null) return undefined;
	const candidate = loaded as Record<string, unknown>;
	const complete =
		isFn(candidate.parseSmsListOutput) &&
		isFn(candidate.parseSmsRecordOutput) &&
		isFn(candidate.classifySmsFailure) &&
		isFn(candidate.selectReadablePaths) &&
		isFn(candidate.sortAndCapSms) &&
		typeof candidate.SMS_INBOX_CAP === "number";
	return complete ? (candidate as unknown as SmsPortModule) : undefined;
}

function portNormalizer(port: SmsPortModule): SmsNormalizer {
	return {
		source: "port",
		cap: port.SMS_INBOX_CAP,
		parseList: (raw) => port.parseSmsListOutput(raw),
		parseRecord: (raw) => port.parseSmsRecordOutput(raw),
		classifyFailure: (description) => port.classifySmsFailure(description),
		selectPaths: (paths) => port.selectReadablePaths(paths, port.SMS_INBOX_CAP),
		sortAndCap: (messages) => port.sortAndCapSms(messages, port.SMS_INBOX_CAP),
	};
}

let resolved: Promise<SmsNormalizer> | undefined;
let override: SmsNormalizer | undefined;

/**
 * Resolve the normalizer once per process, then serve the cache.
 *
 * FAIL-SOFT IN ONE DIRECTION ONLY: a package that cannot be loaded, or that
 * predates the port, degrades to the legacy parsers — behaviour identical to
 * every release before this seam existed. It never degrades the other way.
 */
export function resolveSmsNormalizer(
	fallback: SmsNormalizer,
): Promise<SmsNormalizer> {
	if (override !== undefined) return Promise.resolve(override);
	resolved ??= (async (): Promise<SmsNormalizer> => {
		try {
			const port = asSmsPort(await import("@ceralive/modem-control"));
			if (port === undefined) {
				logger.debug(
					"SMS: pinned @ceralive/modem-control carries no SMS port; using the legacy parsers",
				);
				return fallback;
			}
			logger.debug(
				"SMS: normalization resolved through @ceralive/modem-control",
			);
			return portNormalizer(port);
		} catch {
			return fallback;
		}
	})();
	return resolved;
}

/** Test seam (the `set*Runner` convention). `null` restores real resolution. */
export function setSmsNormalizerForTest(
	normalizer: SmsNormalizer | null,
): void {
	override = normalizer ?? undefined;
	resolved = undefined;
}

/** Exported for the port-shape contract test. */
export const smsPortShape = { asSmsPort, portNormalizer } as const;

export type { SmsState };
