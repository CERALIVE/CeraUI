/**
 * Optimistic dirty-field registry — Task 6
 *
 * Implements the **Field-Lock Contract**: while a user-initiated config write is
 * in flight, the locally-typed ("intended") value wins over any stale server
 * echo of the *old* value, so the UI never flickers back-and-forth. The lock is
 * released only when (a) the owning RPC resolves AND the server sends a message
 * carrying that field (ANY value — accepting hardware-clamped truth), or (b) a
 * per-field TTL expires (the safety valve — a field never stays locked forever).
 *
 * Architecture
 * ------------
 * The contract logic is a set of *pure* functions ({@link registryCore} plus the
 * top-level {@link shouldIgnoreEcho} / {@link reconcile} / {@link expire}) — none
 * of them touch Svelte runes, so they are fully unit-testable under a plain
 * (non-Svelte) vitest environment. The reactive layer ({@link createDirtyStore})
 * is created lazily on first selector access and is the only place that uses
 * runes; it is never executed by the unit tests.
 *
 * This module deliberately does NOT integrate with `subscriptions.svelte.ts` —
 * that wiring is Task 9. Here we only provide the registry + its API.
 */

// ============================================
// Constants
// ============================================

/**
 * Per-field lock lifetime (ms). A field locked longer than this — without its
 * owning RPC resolving and being echoed back — is force-released by {@link expire}.
 * This is the safety valve that guarantees a field can never stay locked forever.
 */
export const FIELD_LOCK_TTL_MS = 10_000;

/** How often the reactive store sweeps for expired locks (ms). */
const TICK_INTERVAL_MS = 1000;

// ============================================
// Pure core (rune-free, unit-testable)
//
// Everything below this banner and above the "Reactive store" banner imports
// nothing from `svelte`, `svelte/store`, or any `$`-rune module. It operates on
// a plain {@link DirtyRegistry} object passed in as the first argument.
// ============================================

/** A single in-flight optimistic write for one config/status field. */
export interface FieldLock {
	/** The value the user intends — wins over stale server echoes of the old value. */
	intendedValue: unknown;
	/** Timestamp (ms) of the most recent edit; drives the per-field TTL. */
	ts: number;
	/**
	 * Whether the owning RPC has resolved. A lock is only released by a server
	 * message once this is `true` (see the Field-Lock Contract).
	 */
	rpcResolved: boolean;
}

/** The dirty-field registry: a plain map of field name → {@link FieldLock}. */
export interface DirtyRegistry {
	locks: Record<string, FieldLock>;
}

/** Result of reconciling one incoming field value against the registry. */
export interface ReconcileResult {
	/** Whether the caller should apply `incomingValue` to its view state. */
	apply: boolean;
	/** Whether this reconcile released (deleted) the field's lock. */
	released: boolean;
}

/** Create an empty registry. */
export function createRegistry(): DirtyRegistry {
	return { locks: {} };
}

/** Whether `field` currently holds a lock. */
export function isLocked(registry: DirtyRegistry, field: string): boolean {
	return field in registry.locks;
}

/**
 * Record an optimistic write for `field`. Re-editing a field overwrites its
 * entry, which RESETS the per-field TTL (the lock does not accumulate). The
 * `rpcResolved` flag is reset to `false` because a fresh edit starts a new
 * in-flight write.
 */
function markPendingField(
	registry: DirtyRegistry,
	field: string,
	intendedValue: unknown,
	now: number,
): DirtyRegistry {
	registry.locks[field] = { intendedValue, ts: now, rpcResolved: false };
	return registry;
}

/**
 * Mark the owning RPC for `field` as resolved. This alone does NOT release the
 * lock — per the contract, release also requires the server to echo the field
 * (handled by {@link reconcile}). No-op if the field is not locked.
 */
function markResolved(registry: DirtyRegistry, field: string): DirtyRegistry {
	const lock = registry.locks[field];
	if (lock) lock.rpcResolved = true;
	return registry;
}

/**
 * Decide whether to ignore an incoming server echo for `field`.
 *
 * Returns `true` (ignore) only when the field is locked AND the incoming value
 * differs from the intended value — i.e. a stale echo of the pre-edit value.
 * Returns `false` (do not ignore) when the field is unlocked, or when the
 * incoming value already matches the user's intent.
 */
export function shouldIgnoreEcho(
	registry: DirtyRegistry,
	field: string,
	incomingValue: unknown,
): boolean {
	const lock = registry.locks[field];
	if (!lock) return false;
	return incomingValue !== lock.intendedValue;
}

/**
 * Reconcile one incoming field value (present in a `config`/`status` message)
 * against the registry. Callers iterate only over fields the message actually
 * carries — so a message that omits a locked field can never release it.
 *
 * - Unlocked field → apply the value, nothing to release.
 * - Locked + `rpcResolved` → release the lock and accept the server value as
 *   truth (ANY value, including a hardware-clamped one).
 * - Locked + still pending: accept a matching echo, but ignore a stale echo of
 *   the old value (keeping the optimistic value on screen).
 */
export function reconcile(
	registry: DirtyRegistry,
	field: string,
	incomingValue: unknown,
	rpcResolved: boolean,
	_now: number,
	options?: { strict?: boolean },
): ReconcileResult {
	const lock = registry.locks[field];
	if (!lock) return { apply: true, released: false };

	if (rpcResolved) {
		// Strict mode holds the lock until a matching echo arrives: a
		// non-matching echo is neither applied nor released (TTL is the valve).
		if (options?.strict && incomingValue !== lock.intendedValue) {
			return { apply: false, released: false };
		}
		delete registry.locks[field];
		return { apply: true, released: true };
	}

	// RPC still in flight: keep the optimistic value, only accept matching echoes.
	if (incomingValue === lock.intendedValue) {
		return { apply: true, released: false };
	}
	return { apply: false, released: false };
}

/**
 * Release every lock older than {@link FIELD_LOCK_TTL_MS}. Returns the names of
 * the fields that were released (empty when nothing expired). This is the safety
 * valve guaranteeing a field can never stay locked forever.
 */
export function expire(registry: DirtyRegistry, now: number): string[] {
	const released: string[] = [];
	for (const field of Object.keys(registry.locks)) {
		const lock = registry.locks[field];
		if (now - lock.ts > FIELD_LOCK_TTL_MS) {
			delete registry.locks[field];
			released.push(field);
		}
	}
	return released;
}

/**
 * The pure core grouped under one namespace so the canonical `markPending`
 * (which the reactive layer re-exports under the same name) stays reachable for
 * unit tests: `import { registryCore } from '...'`.
 */
export const registryCore = {
	createRegistry,
	isLocked,
	markPending: markPendingField,
	markResolved,
	shouldIgnoreEcho,
	reconcile,
	expire,
} as const;

// ============================================
// Reactive store (runes — never run by unit tests)
//
// Everything below is the thin Svelte wrapper. It is created lazily on first
// selector access; the rune-free unit tests exercise the pure core above and
// never touch this layer.
// ============================================

interface DirtyStore {
	isPending: (field: string) => boolean;
	markPending: (field: string, intendedValue: unknown, now?: number) => void;
	markResolved: (field: string) => void;
	shouldIgnoreEcho: (field: string, incomingValue: unknown) => boolean;
	reconcile: (
		field: string,
		incomingValue: unknown,
		now?: number,
		options?: { strict?: boolean },
	) => ReconcileResult;
	expire: (now?: number) => string[];
	getRegistry: () => DirtyRegistry;
	destroy: () => void;
}

/**
 * Create the reactive registry store. Uses runes, so this only ever runs inside
 * the Svelte app — never in the rune-free unit tests, which exercise the pure
 * functions above directly.
 */
function createDirtyStore(): DirtyStore {
	const registry = $state<DirtyRegistry>(createRegistry());

	// The TTL sweep lives inside an $effect so its interval is torn down by the
	// effect's cleanup — no leaked timers under HMR or test teardown.
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const tick = setInterval(() => {
				expire(registry, Date.now());
			}, TICK_INTERVAL_MS);
			return () => clearInterval(tick);
		});
	});

	return {
		isPending: (field) => isLocked(registry, field),
		markPending: (field, intendedValue, now = Date.now()) => {
			markPendingField(registry, field, intendedValue, now);
		},
		markResolved: (field) => {
			markResolved(registry, field);
		},
		shouldIgnoreEcho: (field, incomingValue) => shouldIgnoreEcho(registry, field, incomingValue),
		reconcile: (field, incomingValue, now = Date.now(), options?) =>
			reconcile(registry, field, incomingValue, registry.locks[field]?.rpcResolved ?? false, now, options),
		expire: (now = Date.now()) => expire(registry, now),
		getRegistry: () => registry,
		destroy: () => {
			stopRoot();
		},
	};
}

let singleton: DirtyStore | null = null;

function store(): DirtyStore {
	return (singleton ??= createDirtyStore());
}

// ============================================
// Public selectors
// ============================================

/** Whether `field` currently holds an optimistic lock. */
export function isPending(field: string): boolean {
	return store().isPending(field);
}

/**
 * Record an optimistic write for `field`, resetting its per-field TTL. Call this
 * the moment the user commits an edit, before the RPC resolves.
 */
export function markPending(field: string, intendedValue: unknown, now?: number): void {
	store().markPending(field, intendedValue, now);
}

/**
 * Mark `field`'s owning RPC as resolved. The lock is not released until the
 * server also echoes the field (see {@link reconcile}) or the TTL expires.
 */
export function onRpcResolved(field: string): void {
	store().markResolved(field);
}

/** Whether an incoming server echo for `field` should be ignored as stale. */
export function shouldIgnoreEchoReactive(field: string, incomingValue: unknown): boolean {
	return store().shouldIgnoreEcho(field, incomingValue);
}

/** Reconcile an incoming field value against the live registry. */
export function reconcileReactive(
	field: string,
	incomingValue: unknown,
	now?: number,
	options?: { strict?: boolean },
): ReconcileResult {
	return store().reconcile(field, incomingValue, now, options);
}

/**
 * Force-release every lock past its {@link FIELD_LOCK_TTL_MS} TTL on the live
 * registry, returning the released field names. The reactive store self-sweeps
 * on its own internal interval; this export lets the socket-ingestion layer
 * (`subscriptions.svelte.ts`) drive the same safety valve from its own tick.
 */
export function expireReactive(now?: number): string[] {
	return store().expire(now);
}

/** Tear down the reactive store (TTL timer + effect root). For tests/HMR. */
export function destroyDirtyRegistry(): void {
	singleton?.destroy();
	singleton = null;
}
