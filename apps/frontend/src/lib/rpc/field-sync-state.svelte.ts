/**
 * Per-field sync-state machine — Task 5
 *
 * A thin lifecycle layer **on top of** the optimistic dirty-field registry
 * ({@link ./dirty-registry.svelte}). The dirty-registry answers a single
 * question — "is this field's optimistic value still winning over server
 * echoes?" — but it carries no notion of *where* in its life a write is. This
 * module adds that: a per-field state machine
 *
 *     idle → pending → applying → applied
 *                              ↘ failed
 *
 * so the UI can render an in-flight {@link InlineSpinner} during `applying`, a
 * brief confirmation on `applied`, and a calm error affordance on `failed` —
 * the "native feel" feedback the source-experience plan is built around.
 *
 * Composition, not replacement
 * ----------------------------
 * This is NOT a second lock store. Lock ownership, stale-echo guarding, and the
 * authoritative release-to-`result.applied` contract stay entirely in the
 * dirty-registry. The reactive layer here calls the dirty-registry's existing
 * `markPending` / `onRpcResolved` / `onRpcAppliedReactive` functions at the
 * matching transitions, so a field locked here is the *same* lock the
 * `subscriptions.svelte.ts` ingestion path guards and releases. The state
 * machine only tracks the lifecycle phase alongside it.
 *
 * Two hard contracts inherited from the dirty-registry:
 *   1. `applied` releases the lock to the **server-applied** value
 *      (`result.applied`), never to the value the client typed.
 *   2. A field can never stay locked forever: if no echo arrives, the in-flight
 *      phase is force-released after {@link FIELD_LOCK_TTL_MS}.
 *
 * Status-field exclusion (G4)
 * ---------------------------
 * Status fields (`is_streaming`, `wifi`, `modems`, … — everything sourced from
 * `getStatus()`) are deliberately NOT eligible. They have no optimistic write
 * path and must never take a lock; {@link beginFieldSync} refuses them so a
 * status field can never enter this machine (and therefore never the
 * dirty-registry).
 *
 * Architecture mirrors the dirty-registry: a *pure*, rune-free core
 * ({@link syncCore}) that the unit tests drive directly with injected time, and
 * a lazily-created reactive wrapper (the only part that touches runes, never run
 * by the unit tests).
 */

import {
	FIELD_LOCK_TTL_MS,
	markPending,
	onRpcAppliedReactive,
	onRpcResolved,
} from "./dirty-registry.svelte";

// ============================================
// Constants
// ============================================

/**
 * How long a terminal phase (`applied` / `failed`) lingers before decaying back
 * to `idle`. Long enough for the confirmation / error affordance to register,
 * short enough that a settled field doesn't carry stale chrome. The decay is a
 * pure function of elapsed time (swept on the same tick as the TTL valve), so it
 * is CSS/animation-free — the e-ink freeze cannot strand a terminal indicator.
 */
export const TERMINAL_LINGER_MS = 4_000;

/**
 * Field names that are sourced from `getStatus()` and therefore must NEVER enter
 * the sync-state machine or the dirty-registry (G4). These have no optimistic
 * write path — they are device-reported truth, not user intent. Kept in sync
 * with the `status` handler in `subscriptions.svelte.ts`.
 */
export const STATUS_FIELDS: ReadonlySet<string> = new Set([
	"is_streaming",
	"ssh",
	"available_updates",
	"updating",
	"wifi",
	"modems",
	"linkTelemetry",
]);

/** Whether `field` is a status-owned field that must be excluded (G4). */
export function isStatusField(field: string): boolean {
	return STATUS_FIELDS.has(field);
}

// ============================================
// Pure core (rune-free, unit-testable)
//
// Everything between here and the "Reactive layer" banner imports nothing from
// `svelte` or any `$`-rune module. It operates on a plain {@link SyncRegistry}
// passed in as the first argument, so the whole lifecycle is testable under a
// plain (non-Svelte) vitest environment with explicit `now` timestamps.
// ============================================

/** The lifecycle phase of a single field's optimistic write. */
export type FieldSyncState =
	| "idle"
	| "pending"
	| "applying"
	| "applied"
	| "failed";

/** A non-idle phase that is physically recorded; `idle` is the absence of an entry. */
type ActiveSyncState = Exclude<FieldSyncState, "idle">;

/** The two in-flight phases that hold a dirty-registry lock and obey the TTL valve. */
const IN_FLIGHT: ReadonlySet<ActiveSyncState> = new Set(["pending", "applying"]);

/** The two terminal phases that linger briefly, then decay to `idle`. */
const TERMINAL: ReadonlySet<ActiveSyncState> = new Set(["applied", "failed"]);

/** A single field's lifecycle entry. */
interface FieldSyncEntry {
	/** Current lifecycle phase (an absent field is implicitly `idle`). */
	state: ActiveSyncState;
	/** Timestamp (ms) the field entered `state`; drives the TTL valve + terminal decay. */
	ts: number;
}

/** The sync-state registry: a plain map of field name → {@link FieldSyncEntry}. */
export interface SyncRegistry {
	fields: Record<string, FieldSyncEntry>;
}

/** Create an empty sync-state registry. */
export function createSyncRegistry(): SyncRegistry {
	return { fields: {} };
}

/** The current lifecycle phase of `field` (`idle` when it holds no entry). */
export function getState(registry: SyncRegistry, field: string): FieldSyncState {
	return registry.fields[field]?.state ?? "idle";
}

/**
 * Enter `pending`: the user has committed an optimistic edit to `field` but the
 * RPC has not yet been dispatched (it may be debounced/queued). Re-editing a
 * field re-enters `pending` and RESETS its TTL.
 *
 * Refuses status fields (G4): returns `false` without recording anything, so a
 * status field can never acquire a lifecycle entry.
 */
export function beginPending(
	registry: SyncRegistry,
	field: string,
	now: number,
): boolean {
	if (isStatusField(field)) return false;
	registry.fields[field] = { state: "pending", ts: now };
	return true;
}

/**
 * Transition `pending → applying`: the owning RPC has been dispatched and is in
 * flight. This is the phase the {@link InlineSpinner} renders against. Idempotent
 * while already `applying`. No-op (returns `false`) if the field is not currently
 * in flight — e.g. the TTL valve already released it — so a stale phase is never
 * resurrected.
 */
export function beginApplying(
	registry: SyncRegistry,
	field: string,
	now: number,
): boolean {
	const entry = registry.fields[field];
	if (!entry || !IN_FLIGHT.has(entry.state)) return false;
	entry.state = "applying";
	entry.ts = now;
	return true;
}

/**
 * Transition to `applied`: the owning RPC resolved with the server-applied
 * value. Only valid from an in-flight phase — calling it on an `idle` field is a
 * no-op (returns `false`), which is what enforces "never `applied` without a
 * preceding in-flight write" and keeps a TTL-released field from being revived.
 *
 * NB: this pure function only flips the lifecycle phase. Releasing the lock to
 * the server-applied value is the reactive layer's job (it forwards that value
 * to the dirty-registry); the value is deliberately not stored here.
 */
export function markApplied(
	registry: SyncRegistry,
	field: string,
	now: number,
): boolean {
	const entry = registry.fields[field];
	if (!entry || !IN_FLIGHT.has(entry.state)) return false;
	entry.state = "applied";
	entry.ts = now;
	return true;
}

/**
 * Transition to `failed`: the owning RPC rejected. Only valid from an in-flight
 * phase; a no-op (returns `false`) otherwise.
 */
export function markFailed(
	registry: SyncRegistry,
	field: string,
	now: number,
): boolean {
	const entry = registry.fields[field];
	if (!entry || !IN_FLIGHT.has(entry.state)) return false;
	entry.state = "failed";
	entry.ts = now;
	return true;
}

/** Force `field` back to `idle` (deletes its entry). No-op if already idle. */
export function clearField(registry: SyncRegistry, field: string): void {
	delete registry.fields[field];
}

/**
 * Time-driven sweep — the safety valve. Returns the names of every field that
 * was released back to `idle`, split across two rules:
 *
 *  - **In-flight TTL** (`pending` / `applying`): a field stuck longer than
 *    {@link FIELD_LOCK_TTL_MS} without resolving is force-released. This is the
 *    spinner's escape hatch — it can never hang forever (e.g. an RPC promise
 *    orphaned by a reconnect).
 *  - **Terminal decay** (`applied` / `failed`): a settled field lingers
 *    {@link TERMINAL_LINGER_MS} so its confirmation/error affordance registers,
 *    then clears.
 */
export function sweepSync(registry: SyncRegistry, now: number): string[] {
	const released: string[] = [];
	for (const field of Object.keys(registry.fields)) {
		const entry = registry.fields[field];
		if (!entry) continue;
		const age = now - entry.ts;
		const stuck = IN_FLIGHT.has(entry.state) && age > FIELD_LOCK_TTL_MS;
		const decayed = TERMINAL.has(entry.state) && age > TERMINAL_LINGER_MS;
		if (stuck || decayed) {
			delete registry.fields[field];
			released.push(field);
		}
	}
	return released;
}

/**
 * The pure core grouped under one namespace so the unit tests can drive the
 * canonical transitions directly: `import { syncCore } from '...'`.
 */
export const syncCore = {
	createSyncRegistry,
	getState,
	beginPending,
	beginApplying,
	markApplied,
	markFailed,
	clearField,
	sweepSync,
} as const;

// ============================================
// Reactive layer (runes — never run by unit tests)
//
// The thin Svelte wrapper. Created lazily on first access. This is where the
// lifecycle FSM is composed with the dirty-registry's lock contract: each action
// flips the FSM phase AND calls the matching dirty-registry function, so the two
// stay in lock-step over a single shared lock.
// ============================================

interface SyncStore {
	getFieldState: (field: string) => FieldSyncState;
	beginFieldSync: (field: string, intendedValue: unknown, now?: number) => boolean;
	markFieldApplying: (field: string, now?: number) => void;
	markFieldApplied: (field: string, appliedValue: unknown, now?: number) => void;
	markFieldFailed: (
		field: string,
		authoritativeValue: unknown,
		now?: number,
	) => void;
	sweep: (now?: number) => string[];
	destroy: () => void;
}

/** How often the reactive store sweeps for stuck/decayed entries (ms). */
const TICK_INTERVAL_MS = 1_000;

/**
 * Create the reactive sync-state store. Uses runes, so this only ever runs inside
 * the Svelte app — never in the rune-free unit tests, which exercise {@link syncCore}
 * directly.
 */
function createSyncStore(): SyncStore {
	const registry = $state<SyncRegistry>(createSyncRegistry());

	// The decay/TTL sweep lives inside an $effect so its interval is torn down by
	// the effect's cleanup — no leaked timers under HMR or test teardown.
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const tick = setInterval(() => {
				sweepSync(registry, Date.now());
			}, TICK_INTERVAL_MS);
			return () => clearInterval(tick);
		});
	});

	return {
		getFieldState: (field) => getState(registry, field),
		beginFieldSync: (field, intendedValue, now = Date.now()) => {
			// G4: refuse status fields before touching either store.
			if (!beginPending(registry, field, now)) return false;
			// Take the optimistic lock on the SAME registry the ingestion path guards.
			markPending(field, intendedValue, now);
			return true;
		},
		markFieldApplying: (field, now = Date.now()) => {
			beginApplying(registry, field, now);
		},
		markFieldApplied: (field, appliedValue, now = Date.now()) => {
			// Release the lock to the SERVER-APPLIED value — never the intended one.
			// onRpcResolved first so onRpcApplied takes its fast release path.
			onRpcResolved(field);
			onRpcAppliedReactive(field, appliedValue, now);
			markApplied(registry, field, now);
		},
		markFieldFailed: (field, authoritativeValue, now = Date.now()) => {
			// The optimistic write failed — no confirming echo is coming. Release the
			// lock back to the authoritative value so the field reverts immediately.
			onRpcResolved(field);
			onRpcAppliedReactive(field, authoritativeValue, now);
			markFailed(registry, field, now);
		},
		sweep: (now = Date.now()) => sweepSync(registry, now),
		destroy: () => {
			stopRoot();
		},
	};
}

let singleton: SyncStore | null = null;

function store(): SyncStore {
	singleton ??= createSyncStore();
	return singleton;
}

// ============================================
// Public selectors
// ============================================

/**
 * The current lifecycle phase of `field`. Read inside a reactive context
 * (`$derived`, template, `$effect`) it re-runs whenever the phase changes.
 */
export function getFieldState(field: string): FieldSyncState {
	return store().getFieldState(field);
}

/** Whether `field`'s RPC is in flight — the signal the InlineSpinner renders against. */
export function isFieldApplying(field: string): boolean {
	return store().getFieldState(field) === "applying";
}

/**
 * Begin an optimistic write for `field`: enter `pending` and take the
 * dirty-registry lock, holding the intended value over stale echoes. Returns
 * `false` (and touches nothing) for status fields (G4). Call this the moment the
 * user commits an edit, before dispatching the RPC.
 */
export function beginFieldSync(
	field: string,
	intendedValue: unknown,
	now?: number,
): boolean {
	return store().beginFieldSync(field, intendedValue, now);
}

/** Transition `field` to `applying` once its RPC has been dispatched. */
export function markFieldApplying(field: string, now?: number): void {
	store().markFieldApplying(field, now);
}

/**
 * Resolve `field` to `applied`: release the lock to the SERVER-APPLIED value
 * (`result.applied`, never the client's intended value) and enter the brief
 * `applied` phase. Idempotent against a TTL-released field (the dirty-registry's
 * `onRpcApplied` never resurrects a stale lock, and the FSM transition no-ops).
 */
export function markFieldApplied(
	field: string,
	appliedValue: unknown,
	now?: number,
): void {
	store().markFieldApplied(field, appliedValue, now);
}

/**
 * Fail `field`: release the lock back to the authoritative value and enter the
 * `failed` phase. Call this from the RPC's reject path.
 */
export function markFieldFailed(
	field: string,
	authoritativeValue: unknown,
	now?: number,
): void {
	store().markFieldFailed(field, authoritativeValue, now);
}

/**
 * Force the time-driven sweep on the live registry, returning released field
 * names. The store self-sweeps on its own interval; this export lets the
 * ingestion layer drive the same valve from its own tick if desired.
 */
export function sweepFieldSync(now?: number): string[] {
	return store().sweep(now);
}

/**
 * Eagerly create the reactive store at app startup — call once from `main.ts`,
 * before the app mounts. The store must NOT be first instantiated inside a
 * component's `$derived` (its lazy creation there happens mid-render, which
 * detaches the reactive root so later external transitions never reach the
 * component). Warming it up front — exactly as `initSubscriptions()` warms the
 * dirty-registry — guarantees every `getFieldState` reader is properly wired.
 */
export function initFieldSyncState(): void {
	store();
}

/** Tear down the reactive store (sweep timer + effect root). For tests/HMR. */
export function destroyFieldSyncState(): void {
	singleton?.destroy();
	singleton = null;
}
