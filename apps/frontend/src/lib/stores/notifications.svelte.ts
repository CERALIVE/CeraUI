/**
 * Notifications store — Task 10
 *
 * The single source of truth for *active* device notifications. The backend
 * pushes a `notifications` event (see `subscriptions.svelte.ts`); this store
 * folds each entry into a deduplicated, render-ready {@link ActiveNotification}
 * keyed by `name`. T13 wires the toast host (`LayoutToastHost`) to read from
 * here; T14 deletes the now-duplicate emitter in `subscriptions.svelte.ts`.
 *
 * This module owns *state + text resolution only* — it does NOT render toasts.
 * svelte-sonner rendering stays in `LayoutToastHost` (T13).
 *
 * Architecture (mirrors `hud.svelte.ts` / `connection-ux.svelte.ts`)
 * ------------------------------------------------------------------
 * All decision logic lives in *pure*, rune-free exported functions
 * ({@link resolveNotificationText}, {@link toActiveNotification},
 * {@link pushNotification}, {@link dismissNotification}) so they are fully
 * unit-testable under the plain (non-Svelte) vitest environment. The reactive
 * layer ({@link createNotificationStore}) is created lazily on first access and
 * is the only place that touches Svelte runes — the unit tests never run it.
 *
 * Text resolution (D4/D9/D10)
 * ---------------------------
 * Display text is resolved *once, at push time* via `$LL`
 * (`@ceraui/i18n/svelte`): when `key` is present and exists in the translation
 * tree it is interpolated with `params`; otherwise the raw `msg` is used as the
 * fallback. Resolution is deliberately eager so a later locale change does NOT
 * re-show or re-translate already-active toasts (D10 — stale is accepted).
 *
 * Duration (the LayoutToastHost `* 2500` bug)
 * -------------------------------------------
 * `duration` is seconds on the wire and is converted to milliseconds with
 * `* 1000` — never `* 2500`.
 */
import { getLL } from "@ceraui/i18n/svelte";
import type { Notification, NotificationType } from "@ceraui/rpc/schemas";

// ============================================
// Types
// ============================================

/** A render-ready notification: text already resolved, duration in ms. */
export interface ActiveNotification {
	/** Stable dedup key (== {@link Notification.name}). */
	name: string;
	/** Toast severity. */
	type: NotificationType;
	/** Resolved display text (`$LL[key](params)` or `msg` fallback). */
	text: string;
	/** Whether the operator may manually dismiss the toast. */
	isDismissable: boolean;
	/** Whether the toast persists until explicitly cleared. */
	isPersistent: boolean;
	/** Auto-dismiss duration in **milliseconds** (`duration` seconds × 1000). */
	durationMs: number;
	/** When this entry was pushed (ms epoch). */
	receivedAt: number;
}

/** A callable translation leaf as exposed by the `$LL` proxy. */
type TranslateFn = (
	params?: Record<string, string | number | boolean>,
) => string;

// ============================================
// Pure logic (rune-free, unit-testable)
// ============================================

/**
 * Walk a dotted `key` (e.g. `"notifications.jetsonUndervoltage"`) into the
 * translation tree, returning the leaf translation function only when every
 * segment exists and the leaf is callable. Returns `undefined` for any missing
 * segment so the caller can fall back to `msg`.
 *
 * Uses an explicit `in` guard at each step so the live `$LL` Proxy (whose `has`
 * trap reports real key presence) cannot smuggle in its "missing key returns
 * the key string" fallback — an absent key resolves to `undefined` here, which
 * routes to the `msg` fallback rather than leaking a raw key into the UI.
 */
function lookupTranslation(
	translations: unknown,
	key: string,
): TranslateFn | undefined {
	let current: unknown = translations;
	for (const segment of key.split(".")) {
		if (
			current === null ||
			typeof current !== "object" ||
			!(segment in current)
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return typeof current === "function" ? (current as TranslateFn) : undefined;
}

/**
 * Coerce arbitrary `params` (`Record<string, unknown>`) into the
 * `string | number | boolean` shape the `$LL` interpolator expects. Non-scalar
 * values are stringified rather than dropped.
 */
function toInterpolationParams(
	params: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!params) return out;
	for (const [name, value] of Object.entries(params)) {
		out[name] =
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
				? value
				: String(value);
	}
	return out;
}

/**
 * Resolve the display text for a notification: prefer the localized `key`
 * (interpolated with `params`), falling back to the raw `msg` when `key` is
 * absent or not present in the `translations` tree.
 */
export function resolveNotificationText(
	notification: Pick<Notification, "key" | "params" | "msg">,
	translations: unknown,
): string {
	if (notification.key) {
		const translate = lookupTranslation(translations, notification.key);
		if (translate) return translate(toInterpolationParams(notification.params));
	}
	return notification.msg;
}

/**
 * Project a wire {@link Notification} into a render-ready
 * {@link ActiveNotification}: resolve text against `translations` and convert
 * `duration` seconds → ms (`* 1000`).
 */
export function toActiveNotification(
	notification: Notification,
	translations: unknown,
	now: number,
): ActiveNotification {
	return {
		name: notification.name,
		type: notification.type,
		text: resolveNotificationText(notification, translations),
		isDismissable: notification.is_dismissable,
		isPersistent: notification.is_persistent,
		durationMs: notification.duration * 1000,
		receivedAt: now,
	};
}

/**
 * Fold a notification into the active map, deduplicated by `name` (a repeat
 * name replaces the prior entry rather than appending). Returns a new map; the
 * input is never mutated.
 */
export function pushNotification(
	active: ReadonlyMap<string, ActiveNotification>,
	notification: Notification,
	translations: unknown,
	now: number,
): Map<string, ActiveNotification> {
	const next = new Map(active);
	next.set(
		notification.name,
		toActiveNotification(notification, translations, now),
	);
	return next;
}

/**
 * Remove the entry named `name`. Returns a new map; the input is never mutated.
 * A no-op for an unknown name (still returns a fresh equivalent map).
 */
export function dismissNotification(
	active: ReadonlyMap<string, ActiveNotification>,
	name: string,
): Map<string, ActiveNotification> {
	const next = new Map(active);
	next.delete(name);
	return next;
}

// ============================================
// Reactive store (runes — lazily created)
// ============================================

interface NotificationStore {
	push(notification: Notification): void;
	dismiss(name: string): void;
	getActive(): ActiveNotification[];
	clear(): void;
	destroy(): void;
}

/**
 * Create the reactive notification store. Uses runes, so this only ever runs
 * inside the Svelte app — never in the rune-free unit tests, which exercise the
 * pure functions above directly.
 */
function createNotificationStore(): NotificationStore {
	let active = $state<Map<string, ActiveNotification>>(new Map());

	return {
		push: (notification) => {
			active = pushNotification(active, notification, getLL(), Date.now());
		},
		dismiss: (name) => {
			active = dismissNotification(active, name);
		},
		getActive: () => Array.from(active.values()),
		clear: () => {
			active = new Map();
		},
		destroy: () => {
			active = new Map();
		},
	};
}

// Held on `globalThis` (global-registry symbol) AND created eagerly at module
// load — two deliberate choices that together make notifications render in Vite
// dev:
//   1. globalThis/`Symbol.for`: in dev this `.svelte.ts` module is served under
//      two browser URLs ("…notifications.svelte" for `.svelte` importers like
//      LayoutToastHost vs "…notifications.svelte.ts" for `.ts`/`.svelte.ts`
//      importers like subscriptions), so it evaluates twice. The shared key gives
//      both copies ONE store, so the producer and the toast host agree.
//   2. Eager module-scope creation: the reactive `$state` must be created in
//      module scope (like `relaysState` in subscriptions.svelte.ts), NOT lazily
//      inside the first consumer's `$effect`. A `$state` first created inside the
//      toast host's effect is not tracked when a later `push` mutates it, so the
//      host runs once (empty) and never re-renders.
const STORE_KEY = Symbol.for("ceraui.notificationStore");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: NotificationStore };

const singletonStore: NotificationStore = ((): NotificationStore => {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY] ?? createNotificationStore();
	g[STORE_KEY] = existing;
	return existing;
})();

function store(): NotificationStore {
	return singletonStore;
}

// ============================================
// Public selectors / actions
// ============================================

/** Push a notification, resolving its text now and deduping by `name`. */
export function push(notification: Notification): void {
	store().push(notification);
}

/** Dismiss the active notification with the given `name`. */
export function dismiss(name: string): void {
	store().dismiss(name);
}

/** The current ordered list of active notifications. */
export function getActive(): ActiveNotification[] {
	return store().getActive();
}

/** Clear every active notification (e.g. on stream start/stop). */
export function clearNotifications(): void {
	store().clear();
}

/** Tear down the reactive store. For tests/HMR. */
export function destroyNotificationStore(): void {
	const g = globalThis as GlobalWithStore;
	g[STORE_KEY]?.destroy();
	g[STORE_KEY] = undefined;
}
