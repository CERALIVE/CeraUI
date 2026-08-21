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
 * `modem_shadow` — run the read-only D-Bus observer BESIDE the live mmcli path and
 * record, durably, whether the two agree.
 *
 * This is the evidence engine for the mmcli-retirement gate. It changes NOTHING
 * about how the device is driven: `config.modem_backend` still selects the active
 * backend and still defaults to mmcli, shadow is orthogonal to it, and there is no
 * code path from an observation here to a modem mutation anywhere.
 *
 * ── OPT-IN, ON THE STRICT EQUALITY ──
 *
 * {@link startModemShadowIfEnabled} runs only for `config.modem_shadow === true`.
 * Absent and `false` are the same answer, deliberately: `modem_shadow` has no
 * schema default, so an unconfigured device never reaches the lazy import below
 * and never loads the D-Bus client at all.
 *
 * ── MUTATION-FREE, PROVEN RATHER THAN PROMISED ──
 *
 * Three independent facts, and none of them is a code comment:
 *
 * 1. The observer is typed as `ModemObservationPort` — the package's NARROW read
 *    port, which carries no mutation verb to call.
 * 2. Its transport is wrapped in todo 20's {@link createAuditingDbusTransport},
 *    which FAILS CLOSED: only the three read members are forwarded, and
 *    `org.freedesktop.ModemManager1.Modem.Signal.Setup` is refused BY NAME rather
 *    than as a side effect of not being listed — so a refusal can be asserted as
 *    a deliberate rejection instead of an accident.
 * 3. The wrapper is applied HERE, around whatever `deps.createTransport` returns,
 *    which is what makes the audit test meaningful: the recording fake the test
 *    injects sits BELOW the same wrapper production uses, so what the fake records
 *    is exactly what would have reached the bus.
 *
 * A refusal is survivable by design. Shadow keeps running and counts it — a
 * crash-on-refusal would turn the safety net into a way to take the diagnostic
 * down, and the count is itself evidence worth keeping.
 *
 * ── EVIDENCE IS RECORDED, NOT JUST LOGGED ──
 *
 * Divergences go to a durable JSONL under `/data` as well as the log, and a
 * heartbeat is appended on a fixed cadence. The heartbeat is what makes a quiet
 * day distinguishable from a dead one; see `shadow-evidence.ts`.
 */

import type {
	ModemObservationPort,
	ObservationList,
} from "@ceralive/modem-control";
import type { DbusTransport } from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfig } from "../config.ts";
import {
	type CellularAuditRefusal,
	createAuditingDbusTransport,
} from "./dbus-audit-transport.ts";
import {
	classifyShadowDivergences,
	collectShadowStates,
	logShadowDivergences,
	observationRowToShadowState,
	type ShadowModemDivergence,
	type ShadowModemState,
	type ShadowStateSet,
} from "./shadow-divergence.ts";
import {
	appendShadowEvidence,
	SHADOW_HEARTBEAT_INTERVAL_MS,
	type ShadowEvidenceDeps,
	type ShadowEvidenceInput,
} from "./shadow-evidence.ts";

/** Cancels a scheduled repeating callback. */
export type CancelSchedule = () => void;

export interface ShadowModeDeps {
	/** Build the RAW transport; this module wraps it in the audit transport. */
	readonly createTransport: () => DbusTransport;
	/** Build the read-only observer over the AUDITED transport. */
	readonly createObserver: (transport: DbusTransport) => ModemObservationPort;
	/** Snapshot the mmcli-reported side — the authoritative live path. */
	readonly readMmcliStates: () => ShadowStateSet;
	/** Divergence log sink. Defaults to the redacted `logger.warn`. */
	readonly log?: (msg: string, meta: unknown) => void;
	/** Durable-record sink. Defaults to the `/data` JSONL writer. */
	readonly appendEvidence?: (record: ShadowEvidenceInput) => void;
	/** Passed through to the default evidence writer (tests inject `baseDir`). */
	readonly evidence?: ShadowEvidenceDeps;
	/** Notified when the audit transport refuses a call. */
	readonly onRefusal?: (refusal: CellularAuditRefusal) => void;
	/** Repeating scheduler for heartbeats; defaults to `setInterval`. */
	readonly schedule?: (fn: () => void, ms: number) => CancelSchedule;
	readonly heartbeatIntervalMs?: number;
}

interface RunningShadow {
	readonly observer: ModemObservationPort;
	readonly transport: DbusTransport;
	unobserve: () => void;
	cancelHeartbeat: CancelSchedule;
	lastObservationOk: boolean;
	lastMmcli: ShadowStateSet;
	lastDbus: ShadowStateSet;
	lastDivergences: readonly ShadowModemDivergence[];
	readonly loggedDivergences: Set<string>;
	readonly refusals: { value: number };
}

let running: RunningShadow | undefined;

export function isModemShadowRunning(): boolean {
	return running !== undefined;
}

function defaultSchedule(fn: () => void, ms: number): CancelSchedule {
	const timer = setInterval(fn, ms);
	// A diagnostic must never be the reason the process refuses to exit.
	(timer as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}

function modemRoster(
	mmcli: ShadowStateSet,
	dbus: ShadowStateSet,
): readonly string[] {
	const keys = new Set<string>();
	for (const state of mmcli.states) keys.add(state.deviceKey);
	for (const state of dbus.states) keys.add(state.deviceKey);
	return [...keys].sort();
}

/**
 * Start the read-only shadow observer. Idempotent: a second call while one runs is
 * a no-op, mirroring the composition root's singleton posture.
 */
export async function startModemShadow(deps: ShadowModeDeps): Promise<void> {
	if (running !== undefined) {
		return;
	}

	const append =
		deps.appendEvidence ??
		((record: ShadowEvidenceInput) =>
			appendShadowEvidence(record, deps.evidence ?? {}));

	// Counted from before the observer is even constructed, so a refusal raised
	// during construction is evidence too rather than a lost event.
	const refusalCount = { value: 0 };
	const transport = createAuditingDbusTransport(deps.createTransport(), {
		onRefusal: (refusal) => {
			refusalCount.value += 1;
			logger.debug(
				`modem shadow refused a D-Bus call (mutation-free invariant): ${refusal.member} (${refusal.reason})`,
			);
			deps.onRefusal?.(refusal);
		},
	});
	const observer = deps.createObserver(transport);

	const empty: ShadowStateSet = { states: [], unjoinable: 0 };
	const session: RunningShadow = {
		observer,
		transport,
		unobserve: () => undefined,
		cancelHeartbeat: () => undefined,
		lastObservationOk: false,
		lastMmcli: empty,
		lastDbus: empty,
		lastDivergences: [],
		loggedDivergences: new Set<string>(),
		refusals: refusalCount,
	};

	const compare = (list: ObservationList): void => {
		try {
			const dbus = collectShadowStates(list.rows, observationRowToShadowState);
			const mmcli = deps.readMmcliStates();
			const divergences = classifyShadowDivergences(mmcli.states, dbus.states);

			session.lastObservationOk = list.ok;
			session.lastMmcli = mmcli;
			session.lastDbus = dbus;
			session.lastDivergences = divergences;

			logShadowDivergences(divergences, {
				...(deps.log !== undefined ? { log: deps.log } : {}),
				seen: session.loggedDivergences,
			});
			for (const divergence of divergences) {
				append(toEvidenceRecord(divergence));
			}
		} catch (err) {
			// Shadow must never destabilise the live path — record and carry on.
			logger.debug(`modem shadow: divergence pass failed: ${describe(err)}`);
		}
	};

	const emitHeartbeat = (): void => {
		append({
			kind: "heartbeat",
			observationOk: session.lastObservationOk,
			modemKeys: modemRoster(session.lastMmcli, session.lastDbus),
			mmcliModems: session.lastMmcli.states.length,
			dbusModems: session.lastDbus.states.length,
			divergences: session.lastDivergences.length,
			unjoinableMmcli: session.lastMmcli.unjoinable,
			unjoinableDbus: session.lastDbus.unjoinable,
			refusals: session.refusals.value,
		});
	};

	session.unobserve = observer.observe(compare);
	running = session;

	const schedule = deps.schedule ?? defaultSchedule;
	session.cancelHeartbeat = schedule(
		emitHeartbeat,
		deps.heartbeatIntervalMs ?? SHADOW_HEARTBEAT_INTERVAL_MS,
	);

	const first = await observer.start();
	compare(first);
	// The first heartbeat is emitted eagerly so a device that shadowed for one
	// window before rebooting still leaves proof it observed at all.
	emitHeartbeat();
}

function toEvidenceRecord(
	divergence: ShadowModemDivergence,
): ShadowEvidenceInput {
	if (divergence.kind === "field-mismatch" && divergence.fields !== undefined) {
		const fields: Record<string, { mmcli: unknown; dbus: unknown }> = {};
		for (const field of divergence.fields) {
			fields[field.field] = { mmcli: field.mmcli, dbus: field.dbus };
		}
		return {
			kind: "divergence",
			deviceKey: divergence.deviceKey,
			divergence: divergence.kind,
			fields,
		};
	}
	return {
		kind: "divergence",
		deviceKey: divergence.deviceKey,
		divergence: divergence.kind,
	};
}

/** Stop the observer and release its transport. Idempotent. */
export async function stopModemShadow(): Promise<void> {
	const current = running;
	running = undefined;
	if (current === undefined) {
		return;
	}
	current.cancelHeartbeat();
	current.unobserve();
	try {
		await current.observer.stop();
	} catch (err) {
		logger.debug(`modem shadow: stop() failed: ${describe(err)}`);
	}
	try {
		await current.transport.disconnect();
	} catch (err) {
		logger.debug(`modem shadow: transport disconnect failed: ${describe(err)}`);
	}
}

/** Test seam: drop the running reference synchronously, without awaiting teardown. */
export function resetModemShadow(): void {
	running?.cancelHeartbeat();
	running?.unobserve();
	running = undefined;
}

/** The states the last comparison pass produced. Diagnostics/tests only. */
export function peekShadowSession():
	| {
			readonly mmcli: readonly ShadowModemState[];
			readonly dbus: readonly ShadowModemState[];
			readonly divergences: readonly ShadowModemDivergence[];
			readonly refusals: number;
	  }
	| undefined {
	if (running === undefined) {
		return undefined;
	}
	return {
		mmcli: running.lastMmcli.states,
		dbus: running.lastDbus.states,
		divergences: running.lastDivergences,
		refusals: running.refusals.value,
	} as const;
}

/**
 * Start shadow mode iff `config.modem_shadow === true`. The production deps are
 * built behind a lazy import so an absent or `false` key keeps the D-Bus client —
 * and `@httptoolkit/dbus-native` under it — off the default device's load path
 * entirely, exactly as `cellular-stack.ts` keeps the dbus BACKEND off it.
 */
export async function startModemShadowIfEnabled(): Promise<void> {
	if (getConfig().modem_shadow !== true) {
		return;
	}
	if (shouldUseMocks()) {
		// ONLY the bus is faked. These deps enter the SAME `startModemShadow`,
		// which applies the audit wrapper itself — so a dev run exercises the real
		// classifier, redactor and evidence writer, and the mutation-freedom
		// guarantee still sits above the fake rather than around it.
		const { getMockShadowDeps } = await import(
			"../../mocks/providers/cellular.ts"
		);
		await startModemShadow(getMockShadowDeps());
		return;
	}
	const { buildProductionShadowDeps } = await import("./shadow-wiring.ts");
	await startModemShadow(buildProductionShadowDeps());
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
