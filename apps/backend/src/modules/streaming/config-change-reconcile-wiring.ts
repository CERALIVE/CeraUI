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
 * Production wiring for the crash-window config-change reconciler (F11).
 *
 * `config-change-persistence.ts` shipped `reconcileInflightConfigChange` with the
 * whole marker-only judgement behind it, and NOTHING in production called it —
 * its only importer was its own unit test. `apps/backend/AGENTS.md` described
 * marker-only crash reconciliation as live behaviour the entire time, so a
 * `config.inflight.json` left by a process that died mid-transaction was never
 * judged: the staged candidate was silently lost and the marker file leaked. A
 * dead safety net the docs claimed was armed.
 *
 * This module is the arming. It owns two things the pure reconciler deliberately
 * does not:
 *
 *   1. WHERE the engine's answer comes from (`buildEngineEncodeSnapshot`), and
 *   2. WHEN to ask (`runInflightConfigChangeReconciliation`).
 *
 * THE SNAPSHOT SPEAKS CONFIG SPACE, NOT ENGINE SPACE. `judgeInflightMarker`
 * compares the marker's fields — which are `config.json` values — against the
 * engine's report with `===`. The engine speaks PIXELS (`"3840x2160"`) and exact
 * rates (`29.97` from `30000/1001`), exactly as it does on the apply-now dispatch
 * path (see config-change-bridge.ts "THE ENGINE SPEAKS PIXELS"). So the values are
 * normalized to the rung ladder HERE, at the one seam that knows it is talking to
 * the engine; the judge stays pure and unit-comparable.
 *
 * A NON-ANSWER IS NOT "NOT STREAMING". The lifecycle is read from the orchestrator
 * rather than the bare `is_streaming` flag, because that flag is false both when
 * the engine is genuinely idle AND while reconciliation has not yet reached it.
 * Only `idle` is decisive evidence of an unchanged session; `reconciling` /
 * `starting` / `stopping` yield `undefined`, which the judge answers with `wait`.
 * Reading the flag instead would retain the previous values off a non-answer —
 * discarding a change the operator DID get.
 *
 * IT IS BOUNDED AND MARKER-GATED. With no marker the runner returns immediately
 * and never even asks the engine (proving marker-only semantics by construction,
 * not by convention). With a marker it polls a bounded number of times, because at
 * boot the decisive evidence arrives on someone else's schedule: the engine
 * session is reconciled a few lines earlier, but `frames_emitted` /
 * `pipeline_playing` ride the raw `active_encode` bridge, whose first status frame
 * lands a second or two later. An engine that never becomes decisive within the
 * window simply defers — which KEEPS the marker for the next reconnect, exactly as
 * the wave3 contract requires.
 *
 * IT IS IDEMPOTENT, TWO WAYS. A decisive verdict retires the marker, so a repeat
 * call is a plain `no_marker` no-op; and concurrent callers (boot racing an
 * engine-reconnect heal) share ONE in-flight run rather than judging in parallel.
 */

import type { ActiveEncode, LifecycleState } from "@ceraui/rpc/schemas";
import {
	normalizeFramerateToRung,
	normalizeResolutionToRung,
} from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { getActiveEncodeStatus } from "./active-encode-status.ts";
import { getActiveEncodeLiveness } from "./active-passthrough.ts";
import {
	type InflightReconciliation,
	reconcileInflightConfigChange,
} from "./config-change-persistence.ts";
import {
	defaultStagingDeps,
	type EngineEncodeSnapshot,
	readInflightMarker,
	type StagingDeps,
} from "./config-change-staging.ts";
import { getStreamSessionSnapshot } from "./stream-session-orchestrator.ts";

/** How long to wait between re-asking an engine that has not answered yet. */
export const INFLIGHT_RECONCILE_POLL_MS = 1_000;
/**
 * The whole window a boot/reconnect gets to reach a decisive engine answer.
 * Sized to comfortably cover the raw `active_encode` bridge's connect + first
 * status heartbeat (~2 s cadence). Expiry is not a failure — it defers, which
 * keeps the marker for the next reconnect.
 */
export const INFLIGHT_RECONCILE_DEADLINE_MS = 15_000;

/** Where the engine's current encode is read from. Injected so tests can pin it. */
export interface EngineSnapshotSources {
	readonly lifecycle: () => LifecycleState;
	readonly activeEncode: () => ActiveEncode | null;
	readonly liveness: () =>
		| {
				pipelinePlaying?: boolean | undefined;
				framesEmitted?: number | undefined;
		  }
		| undefined;
}

const productionSnapshotSources: EngineSnapshotSources = {
	lifecycle: () => getStreamSessionSnapshot().state,
	activeEncode: () => getActiveEncodeStatus(),
	liveness: () => getActiveEncodeLiveness(),
};

/**
 * Build the engine's current encode in CONFIG space, or `undefined` when the
 * engine has not actually answered.
 *
 * `undefined` is a first-class outcome, never a fallback: it is what the judge
 * turns into `wait`, which writes nothing and keeps the marker. Only two states
 * are decisive — a lifecycle of `idle` (the session really is over) and a
 * `streaming` lifecycle for which the engine reported a resolved encode.
 */
export function buildEngineEncodeSnapshot(
	sources: EngineSnapshotSources = productionSnapshotSources,
): EngineEncodeSnapshot | undefined {
	const lifecycle = sources.lifecycle();
	// Decisive: the engine answered, and its answer is "no session".
	if (lifecycle === "idle") return { streaming: false };
	// Every other non-streaming lifecycle is an ABSENT answer, not a negative one.
	if (lifecycle !== "streaming") return undefined;

	const encode = sources.activeEncode();
	if (encode === null) return undefined;

	const resolution = normalizeResolutionToRung(encode.resolution);
	const framerate = normalizeFramerateToRung(encode.framerate);
	const live = sources.liveness();

	return {
		streaming: true,
		...(resolution === undefined ? {} : { resolution }),
		...(framerate === undefined ? {} : { framerate }),
		codec: encode.codec,
		...(encode.active_input === undefined
			? {}
			: { activeInput: encode.active_input }),
		...(live?.pipelinePlaying === undefined
			? {}
			: { pipelinePlaying: live.pipelinePlaying }),
		...(live?.framesEmitted === undefined
			? {}
			: { framesEmitted: live.framesEmitted }),
	};
}

/** Minimal logger surface (winston satisfies it; tests pass a silent stub). */
export interface InflightReconcileLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

export interface InflightReconcileDeps {
	readonly staging: StagingDeps;
	readonly snapshot: () => EngineEncodeSnapshot | undefined;
	readonly reconcile: (
		engine: EngineEncodeSnapshot | undefined,
		staging: StagingDeps,
	) => InflightReconciliation;
	readonly wait: (ms: number) => Promise<void>;
	readonly logger: InflightReconcileLogger;
	readonly pollIntervalMs: number;
	readonly deadlineMs: number;
}

function defaultDeps(): InflightReconcileDeps {
	return {
		staging: defaultStagingDeps,
		snapshot: () => buildEngineEncodeSnapshot(),
		reconcile: (engine, staging) =>
			reconcileInflightConfigChange(engine, staging),
		wait: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
		logger: defaultLogger,
		pollIntervalMs: INFLIGHT_RECONCILE_POLL_MS,
		deadlineMs: INFLIGHT_RECONCILE_DEADLINE_MS,
	};
}

let inflight: Promise<InflightReconciliation> | undefined;

/**
 * Bounded by ATTEMPTS rather than a wall clock: the loop's only delay is its own
 * `wait`, so attempts × interval IS the window, and the bound holds identically
 * under an instant test clock. A clock compare would spin hot in tests and add a
 * seam that proves nothing.
 */
async function pollUntilDecisive(
	deps: InflightReconcileDeps,
): Promise<InflightReconciliation> {
	const attempts = Math.max(
		1,
		Math.ceil(deps.deadlineMs / Math.max(1, deps.pollIntervalMs)),
	);
	for (let attempt = 1; ; attempt += 1) {
		const verdict = deps.reconcile(deps.snapshot(), deps.staging);
		if (verdict !== "deferred") return verdict;
		if (attempt >= attempts) return "deferred";
		await deps.wait(deps.pollIntervalMs);
	}
}

/**
 * Judge a `config.inflight.json` left behind by a process that died mid
 * transaction. Safe to call from any number of seams, at any time.
 *
 * Fail-soft by contract: it never throws, so a boot/reconnect hook can call it
 * without a guard of its own.
 */
export function runInflightConfigChangeReconciliation(
	overrides: Partial<InflightReconcileDeps> = {},
): Promise<InflightReconciliation> {
	// A run already judging this marker owns it — a second caller must join it,
	// not race it. This is what makes a repeatedly-firing reconnect hook harmless.
	if (inflight !== undefined) return inflight;

	const deps: InflightReconcileDeps = { ...defaultDeps(), ...overrides };

	// MARKER-ONLY, enforced by construction: with no marker the engine is never
	// asked at all. A bare params-vs-config mismatch is a legitimate
	// "apply on next start" the operator chose, and reconciling it would overwrite
	// their intent on every single boot.
	let marker: ReturnType<typeof readInflightMarker>;
	try {
		marker = readInflightMarker(deps.staging);
	} catch {
		return Promise.resolve("no_marker");
	}
	if (marker === undefined) return Promise.resolve("no_marker");

	// `warn` because the production console transport is at `warn`: an `info`
	// here lands in the log file but never in the journal (see the same note in
	// config-change-persistence.ts). Bounded by construction — a marker exists
	// only after a crashed transaction, and is retired by the first decisive
	// verdict.
	deps.logger.warn("config-change in-flight marker found — reconciling", {
		module: "streaming",
		attemptId: marker.attemptId,
	});

	const run = pollUntilDecisive(deps)
		.then((verdict) => {
			if (verdict === "deferred") {
				deps.logger.warn(
					"config-change marker still undecided — kept for the next reconnect",
					{ module: "streaming", attemptId: marker?.attemptId },
				);
			}
			return verdict;
		})
		.catch((err: unknown) => {
			// Never let a reconciliation fault reach a boot/reconnect hook. Leaving
			// the marker in place is the safe end state — it will be re-judged.
			deps.logger.warn("config-change marker reconciliation failed", {
				module: "streaming",
				err,
			});
			return "deferred" as InflightReconciliation;
		})
		.finally(() => {
			inflight = undefined;
		});

	inflight = run;
	return run;
}

/**
 * Test/teardown seam: resolve once the in-flight reconciliation has settled
 * (mirrors `settleEngineReconnect()`). Returns immediately when idle.
 */
export function settleInflightConfigChangeReconciliation(): Promise<unknown> {
	return inflight ?? Promise.resolve();
}
