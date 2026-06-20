/**
 * Keyed async-operation transition primitive — T1 (ceraui-os-interaction-ux)
 *
 * A keyed status-domain state machine for one-shot OS commands (reboot, update,
 * power-off, SSH toggle, …) where the device reports back asynchronously — or
 * never. Each operation is tracked by a caller-chosen `key` through the phases
 *
 *     idle → pending → confirmed
 *                    ↘ failed
 *                    ↘ timed_out
 *
 * It is a SIBLING of {@link ./streaming-optimism.svelte} and
 * {@link ./field-sync-state.svelte}, not a replacement: it is its OWN store and
 * deliberately does NOT touch the dirty-registry (G4). OS status operations have
 * no optimistic config-write path — they are fire-and-await commands — so they
 * must never take a field lock.
 *
 * `timed_out` vs `failed`
 * -----------------------
 * The two terminal-failure phases are distinct on purpose:
 *   - `failed`    = an explicit reject / DEVICE_BUSY / discrete failure signal.
 *   - `timed_out` = the TTL lapsed with no confirming OR failing signal. The
 *     sweep transitions a stale `pending` to `timed_out` (it does NOT delete it),
 *     so a surface can still render "Still working / taking longer than expected
 *     — Retry" instead of silently dropping the operation.
 * Retry simply re-invokes the SAME `osCommand`; re-`begin` on any phase re-arms
 * the entry (overwriting is allowed), so a stale-pending re-dispatch is safe.
 *
 * Terminal phases (`confirmed` / `failed` / `timed_out`) linger briefly so their
 * inline affordance registers, then the sweep decays them to `idle` (deletes the
 * entry). Feedback is the inline phase render — the sweep loop never toasts.
 *
 * Architecture mirrors the siblings: a *pure*, rune-free core
 * ({@link asyncOpCore}) the unit tests drive directly with injected `now`, and a
 * lazily-created reactive wrapper (the only part that touches runes, never run by
 * the unit tests) with an `$effect.root` self-sweep.
 */

import { getLL } from "@ceraui/i18n/svelte";
import { toast } from "svelte-sonner";

import type { ConnectionState } from "./client";
import { shouldReconcileOnReconnect } from "./reconcile-inflight";

// ============================================
// Types
// ============================================

/** The lifecycle phase of a single keyed async operation. */
export type AsyncOpPhase =
	| "idle"
	| "pending"
	| "confirmed"
	| "failed"
	| "timed_out";

/** A non-idle phase that is physically recorded; `idle` is the absence of an entry. */
interface AsyncOpEntry {
	/** Current phase (an absent key is implicitly `idle`). */
	phase: Exclude<AsyncOpPhase, "idle">;
	/** The intended target of the operation (opaque to the core). */
	target?: unknown;
	/** Failure reason (set only on `failed`). */
	reason?: string;
	/** Timestamp (ms) the key entered `phase`; drives the TTL valve + terminal decay. */
	ts: number;
}

/** The async-operation registry: a plain map of key → {@link AsyncOpEntry}. */
export interface AsyncOpRegistry {
	ops: Record<string, AsyncOpEntry>;
}

// ============================================
// Constants
// ============================================

/**
 * How long a `pending` op may run before the sweep flips it to `timed_out`. The
 * surface then renders "still working / Retry" rather than dropping it silently.
 */
export const ASYNC_OP_TTL_MS = 15_000;

/**
 * How long a terminal phase (`confirmed` / `failed` / `timed_out`) lingers before
 * the sweep decays it back to `idle` (deletes the entry). Long enough for the
 * inline affordance to register, short enough that a settled op carries no stale
 * chrome.
 */
export const ASYNC_OP_TERMINAL_LINGER_MS = 4_000;

/**
 * The scan-settle window for a manual WiFi scan. `rpc.wifi.scan` returns the
 * moment the rescan is dispatched and the available-network set carries no
 * scan-complete marker, so a scan is confirmed only when its content signature
 * changes (a new/removed AP). If the environment yields no change within this
 * window the absolute TTL valve ({@link ASYNC_OP_TTL_MS}) flips the op to
 * `timed_out`, which a scan surface renders as a NEUTRAL "scan complete / no new
 * networks" — never an error. Distinct from {@link ASYNC_OP_TTL_MS} on purpose.
 */
export const WIFI_SCAN_SETTLE_MS = 8_000;

// ============================================
// Pure core (rune-free, unit-testable)
//
// Everything between here and the "Reactive layer" banner imports nothing from
// `svelte` or any `$`-rune module. It operates on a plain {@link AsyncOpRegistry}
// passed in as the first argument, so the whole lifecycle is testable under a
// plain (non-Svelte) vitest environment with explicit `now` timestamps.
// ============================================

/** The two terminal-failure phases reached by the sweep, kept distinct from `confirmed`. */
const TERMINAL: ReadonlySet<AsyncOpEntry["phase"]> = new Set([
	"confirmed",
	"failed",
	"timed_out",
]);

/** Create an empty async-operation registry. */
export function createRegistry(): AsyncOpRegistry {
	return { ops: {} };
}

/** The current phase of `key` (`idle` when it holds no entry). */
export function getPhase(reg: AsyncOpRegistry, key: string): AsyncOpPhase {
	return reg.ops[key]?.phase ?? "idle";
}

/** Whether `key` is currently in flight (`pending`). */
export function isPending(reg: AsyncOpRegistry, key: string): boolean {
	return reg.ops[key]?.phase === "pending";
}

/** The failure reason recorded for `key` (only ever set on `failed`). */
export function getReason(
	reg: AsyncOpRegistry,
	key: string,
): string | undefined {
	return reg.ops[key]?.reason;
}

/**
 * Begin an operation: enter `pending` and reset the TTL. Calling `begin` from
 * ANY phase re-arms the entry (overwriting is allowed) — this is what makes a
 * Retry on a stale-pending or terminal op safe. Always succeeds (`true`).
 */
export function begin(
	reg: AsyncOpRegistry,
	key: string,
	target: unknown,
	now: number,
): boolean {
	reg.ops[key] = { phase: "pending", target, ts: now };
	return true;
}

/**
 * Transition `pending → confirmed`: the device reported success. No-op
 * (returns `false`) from any non-pending phase, so a TTL-released or already
 * terminal op is never resurrected.
 */
export function confirm(
	reg: AsyncOpRegistry,
	key: string,
	now: number,
): boolean {
	const entry = reg.ops[key];
	if (entry?.phase !== "pending") return false;
	entry.phase = "confirmed";
	entry.reason = undefined;
	entry.ts = now;
	return true;
}

/**
 * Transition `pending → failed`: an explicit reject / DEVICE_BUSY / discrete
 * failure signal arrived. No-op (returns `false`) from any non-pending phase.
 */
export function fail(
	reg: AsyncOpRegistry,
	key: string,
	reason: string,
	now: number,
): boolean {
	const entry = reg.ops[key];
	if (entry?.phase !== "pending") return false;
	entry.phase = "failed";
	entry.reason = reason;
	entry.ts = now;
	return true;
}

/**
 * Transition `pending → timed_out`: the TTL lapsed with no confirming/failing
 * signal. Distinct from {@link fail} — the surface renders "still working /
 * Retry". No-op (returns `false`) from any non-pending phase.
 */
export function timeout(
	reg: AsyncOpRegistry,
	key: string,
	now: number,
): boolean {
	const entry = reg.ops[key];
	if (entry?.phase !== "pending") return false;
	entry.phase = "timed_out";
	entry.ts = now;
	return true;
}

/** Force `key` back to `idle` (deletes its entry). No-op if already idle. */
export function clear(reg: AsyncOpRegistry, key: string): void {
	delete reg.ops[key];
}

/**
 * Time-driven sweep — the safety valve. Returns the names of every key that was
 * transitioned or released, split across two rules:
 *
 *  - **Pending TTL**: a `pending` op older than {@link ASYNC_OP_TTL_MS} is
 *    flipped to `timed_out` (NOT deleted) so the surface can keep showing it.
 *    A subsequent sweep does not re-emit it (it is no longer `pending`).
 *  - **Terminal decay**: a `confirmed` / `failed` / `timed_out` op older than
 *    {@link ASYNC_OP_TERMINAL_LINGER_MS} is deleted (decays to `idle`).
 */
export function sweep(reg: AsyncOpRegistry, now: number): string[] {
	const changed: string[] = [];
	for (const key of Object.keys(reg.ops)) {
		const entry = reg.ops[key];
		if (!entry) continue;
		const age = now - entry.ts;
		if (entry.phase === "pending") {
			if (age > ASYNC_OP_TTL_MS) {
				entry.phase = "timed_out";
				entry.ts = now;
				changed.push(key);
			}
		} else if (TERMINAL.has(entry.phase) && age > ASYNC_OP_TERMINAL_LINGER_MS) {
			delete reg.ops[key];
			changed.push(key);
		}
	}
	return changed;
}

/**
 * The pure core grouped under one namespace so the unit tests can drive the
 * canonical transitions directly: `import { asyncOpCore } from '...'`. Mirrors
 * the `syncCore` shape in `field-sync-state.svelte.ts`.
 */
export const asyncOpCore = {
	createRegistry,
	getPhase,
	isPending,
	getReason,
	begin,
	confirm,
	fail,
	timeout,
	clear,
	sweep,
} as const;

// ============================================
// Reactive layer (runes — never run by unit tests)
//
// The thin Svelte wrapper. Created lazily on first access. An `$effect.root`
// drives the self-sweep interval so the TTL valve + terminal decay run without
// any consumer ticking them, mirroring the sibling stores.
// ============================================

interface AsyncOpStore {
	getPhase: (key: string) => AsyncOpPhase;
	isPending: (key: string) => boolean;
	getReason: (key: string) => string | undefined;
	begin: (key: string, target?: unknown, now?: number) => void;
	confirm: (key: string, now?: number) => void;
	fail: (key: string, reason: string, now?: number) => void;
	timeout: (key: string, now?: number) => void;
	clear: (key: string) => void;
	reconcileOnReconnect: (
		previous: ConnectionState,
		next: ConnectionState,
	) => void;
	sweep: (now?: number) => string[];
	destroy: () => void;
}

/** How often the reactive store sweeps for stuck/decayed entries (ms). */
const TICK_INTERVAL_MS = 1_000;

/**
 * Create the reactive async-operation store. Uses runes, so this only ever runs
 * inside the Svelte app — never in the rune-free unit tests, which exercise
 * {@link asyncOpCore} directly.
 */
function createAsyncOpStore(): AsyncOpStore {
	const registry = $state<AsyncOpRegistry>(createRegistry());

	// The TTL/decay sweep lives inside an $effect so its interval is torn down by
	// the effect's cleanup — no leaked timers under HMR or test teardown.
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const tick = setInterval(() => {
				sweep(registry, Date.now());
			}, TICK_INTERVAL_MS);
			return () => clearInterval(tick);
		});
	});

	return {
		getPhase: (key) => getPhase(registry, key),
		isPending: (key) => isPending(registry, key),
		getReason: (key) => getReason(registry, key),
		begin: (key, target, now = Date.now()) => {
			begin(registry, key, target, now);
		},
		confirm: (key, now = Date.now()) => {
			confirm(registry, key, now);
		},
		fail: (key, reason, now = Date.now()) => {
			fail(registry, key, reason, now);
		},
		timeout: (key, now = Date.now()) => {
			timeout(registry, key, now);
		},
		clear: (key) => {
			clear(registry, key);
		},
		reconcileOnReconnect: (previous, next) => {
			// On the reconnect edge, drop every still-pending latch: the post-reconnect
			// getStatus hydrate provides the real value, so a stale pending must not
			// linger. Steady connected→connected ticks reconcile nothing.
			for (const key of Object.keys(registry.ops)) {
				if (
					isPending(registry, key) &&
					shouldReconcileOnReconnect(previous, next, true)
				) {
					clear(registry, key);
				}
			}
		},
		sweep: (now = Date.now()) => sweep(registry, now),
		destroy: () => {
			stopRoot();
		},
	};
}

let singleton: AsyncOpStore | null = null;

function store(): AsyncOpStore {
	singleton ??= createAsyncOpStore();
	return singleton;
}

// ============================================
// Public selectors
// ============================================

/**
 * The current phase of `key`. Read inside a reactive context (`$derived`,
 * template, `$effect`) it re-runs whenever the phase changes.
 */
export function getOperationPhase(key: string): AsyncOpPhase {
	return store().getPhase(key);
}

/** Whether `key`'s operation is in flight (`pending`). */
export function isOperationPending(key: string): boolean {
	return store().isPending(key);
}

/** The failure reason recorded for `key` (only ever set on `failed`). */
export function getOperationReason(key: string): string | undefined {
	return store().getReason(key);
}

/**
 * Begin an async operation for `key`: enter `pending` and reset its TTL. Call
 * this the moment the OS command is dispatched. Re-`begin` on any phase re-arms
 * the entry, so a Retry on a stale-pending/terminal op is safe.
 */
export function beginOperation(key: string, target?: unknown): void {
	store().begin(key, target);
}

/** Resolve `key` to `confirmed` (the device reported success). */
export function confirmOperation(key: string): void {
	store().confirm(key);
}

/** Fail `key` with a reason (explicit reject / DEVICE_BUSY / discrete failure). */
export function failOperation(key: string, reason: string): void {
	store().fail(key, reason);
}

/** Flip `key` to `timed_out` (the TTL lapsed with no confirming/failing signal). */
export function timeoutOperation(key: string): void {
	store().timeout(key);
}

/** Force `key` back to `idle` (deletes its entry). */
export function clearOperation(key: string): void {
	store().clear(key);
}

/**
 * Drop every still-pending latch on a reconnect edge. For each currently-pending
 * key, applies {@link shouldReconcileOnReconnect} and clears it when the
 * transport returns to `connected` — the post-reconnect getStatus hydrate then
 * provides the authoritative value. Wire this into a `$effect` that reads
 * `getConnectionState()`.
 */
export function reconcileOperationsOnReconnect(
	previous: ConnectionState,
	next: ConnectionState,
): void {
	store().reconcileOnReconnect(previous, next);
}

/**
 * Force the time-driven sweep on the live registry, returning changed keys. The
 * store self-sweeps on its own interval; this export lets a consumer drive the
 * same valve from its own tick if desired.
 */
export function sweepOperations(now?: number): string[] {
	return store().sweep(now);
}

/**
 * Eagerly create the reactive store at app startup — call once from `main.ts`,
 * before the app mounts. The store must NOT be first instantiated inside a
 * component's `$derived` (its lazy creation there happens mid-render, which
 * detaches the reactive root so later external transitions never reach the
 * component). Warming it up front guarantees every selector reader is wired.
 */
export function initAsyncOperations(): void {
	store();
}

/** Tear down the reactive store (sweep timer + effect root). For tests/HMR. */
export function destroyAsyncOperations(): void {
	singleton?.destroy();
	singleton = null;
}

// ============================================
// osCommand — the single OS-op dispatch helper
//
// The one entry point a surface calls to fire an OS command (reboot, update,
// SSH toggle, modem configure, WiFi connect, …) AND own its feedback. It begins
// the keyed operation, awaits the raw `rpc.*` call the caller hands it,
// classifies the result, and surfaces the SINGLE source of failure feedback —
// no surface that routes through `osCommand` should toast a failure elsewhere.
// ============================================

/** The classification of an OS-op result: terminal-ok, busy, or a discrete failure. */
interface OsCommandVerdict {
	ok: boolean;
	busy?: boolean;
	reason?: string;
}

/**
 * The default result classifier: a structured `{ success, error }` mutation
 * result is a failure when `success` is false; `error === "DEVICE_BUSY"` is the
 * device-global-lock contention signal (busy). Anything else (no `success`
 * field, or `success: true`) is treated as ok. A custom `classify` on the
 * options overrides this for non-`{success}`-shaped results.
 */
function defaultClassify(r: unknown): OsCommandVerdict {
	if (r !== null && typeof r === "object" && "success" in r) {
		const result = r as { success: boolean; error?: string };
		if (!result.success) {
			return {
				ok: false,
				busy: result.error === "DEVICE_BUSY",
				reason: result.error,
			};
		}
	}
	return { ok: true };
}

/**
 * Dispatch an OS command through the keyed async-operation state machine and own
 * its feedback in one place.
 *
 * Contract:
 *  - **Re-entry guard**: if `key` is already `pending`, this is a NO-OP and
 *    returns `undefined` without dispatching `opts.rpc` — the real
 *    anti-double-dispatch guard, and the reason a re-entrant call dropped by the
 *    modem global lock never leaves a stuck spinner.
 *  - `opts.rpc` MUST be a raw `rpc.*` method call; `osCommand` only awaits it.
 *  - On a non-ok verdict it transitions `key → failed` and toasts the busy/fail
 *    message thunk (falling back to `wifiSelector.os.operationFailed`). This is
 *    the SINGLE failure-feedback path for the surface.
 *  - With `confirmOnResolve` (synchronous ops only — SIM PIN/PUK) an ok verdict
 *    transitions `key → confirmed`. Without it the op stays `pending`: the
 *    per-surface `$effect` confirms on the authoritative broadcast, or the TTL
 *    valve flips it to `timed_out`.
 *  - `onResult` runs with the raw result on any resolve (ok or not).
 *  - A thrown `rpc` transitions `key → failed` and toasts, returning `undefined`.
 */
export async function osCommand<T>(opts: {
	key: string;
	target?: unknown;
	rpc: () => Promise<T>;
	classify?: (r: T) => OsCommandVerdict;
	confirmOnResolve?: boolean;
	busyMessage?: () => string;
	failMessage?: () => string;
	onResult?: (r: T) => void;
}): Promise<T | undefined> {
	// Re-entry guard: never dispatch a second RPC for an in-flight key.
	if (isOperationPending(opts.key)) return undefined;

	beginOperation(opts.key, opts.target);
	try {
		const r = await opts.rpc();
		const v = opts.classify?.(r) ?? defaultClassify(r);
		if (!v.ok) {
			failOperation(opts.key, v.reason ?? (v.busy ? "device_busy" : "failed"));
			toast.error(
				(v.busy ? opts.busyMessage : opts.failMessage)?.() ??
					getLL().network.os.operationFailed(),
			);
		} else if (opts.confirmOnResolve) {
			confirmOperation(opts.key);
		}
		// else: stay pending; the per-surface $effect confirms on the authoritative
		// broadcast, or the TTL valve flips it to timed_out.
		opts.onResult?.(r);
		return r;
	} catch (e) {
		failOperation(opts.key, e instanceof Error ? e.message : "error");
		toast.error(
			opts.failMessage?.() ?? getLL().network.os.operationFailed(),
		);
		return undefined;
	}
}
