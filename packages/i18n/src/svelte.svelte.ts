/**
 * `@ceraui/i18n/svelte` — the ONE facade every frontend call site imports.
 *
 * A thin Svelte 5 runes store over the paraglide runtime plus the generated
 * message registry. Three things are deliberate:
 *
 * 1. **`m` is a reactive proxy, but the calls stay synchronous.** Its `get` trap
 *    reads the locale rune, so `m["live.setup.title"]()` inside a template
 *    registers a dependency on the locale and re-renders on a switch — while
 *    still being a plain synchronous call with no await and no store subscription.
 *
 * 2. **`setLocale` owns the re-render AND the DOM.** Paraglide calls
 *    `setLocale(next, { reload: false })` a "narrow escape hatch": it updates the
 *    runtime's own locale and nothing else — no Svelte re-render, no
 *    `<html lang>`, no `<html dir>`. All three are this module's job.
 *
 * 3. **Direction comes from `RTL_LANGUAGES`, not `getTextDirection()`.**
 *    Paraglide ships a `getTextDirection(locale)` helper that would answer the
 *    same thing for `ar` today, but the e2e locale-parity spec is written against
 *    our own list and that list carries languages we have not shipped yet. The
 *    switch would be silent and is not made.
 *
 * PERSISTENCE IS NOT HERE. The saved preference lives in the frontend's existing
 * `$persist` store (`apps/frontend/src/lib/stores/locale.svelte.ts`, key
 * `"locale"`, shape unchanged) — a package under `packages/` may not reach into
 * an app. `initLocale({ saved })` takes the saved code as an argument instead.
 */

import {
	getMessage,
	type MessageFn,
	type MessageKey,
	type Namespace,
	ensureNamespace as registryEnsureNamespace,
	resolveMessageKey as registryResolveMessageKey,
	m as staticMessages,
} from "../generated/registry.js";
import {
	getLocale as paraglideGetLocale,
	setLocale as paraglideSetLocale,
} from "../generated/runtime.js";
import {
	BASE_LOCALE,
	directionFor,
	type LocaleCode,
	resolveInitialLocale,
} from "./locale-lifecycle.js";

export type {
	MessageFn,
	MessageKey,
	Namespace,
} from "../generated/registry.js";
export {
	BASE_LOCALE,
	directionFor,
	isSupportedLocale,
	LOCALES,
	type LocaleCode,
	RTL_LANGUAGES,
} from "./locale-lifecycle.js";

let localeState = $state<LocaleCode>(BASE_LOCALE);
let loadingState = $state(false);

/** The active locale. Reactive — reading it in a template tracks locale changes. */
export function getLocale(): LocaleCode {
	return localeState;
}

/** True while a lazy namespace is being fetched. Always false under an all-eager config. */
export function isLocaleLoading(): boolean {
	return loadingState;
}

/** Mirror the active locale onto `<html lang>` / `<html dir>`. */
function syncDocumentLocale(locale: string): void {
	if (typeof document === "undefined") return;
	document.documentElement.lang = locale;
	document.documentElement.dir = directionFor(locale);
}

/**
 * Switch locale: paraglide runtime, the reactive store, and the DOM contract —
 * in that order, all synchronously. `reload: false` keeps the operator on the
 * current document; everything it declines to do is done here.
 */
export function setLocale(next: string): LocaleCode {
	const resolved = resolveInitialLocale(next, undefined);
	if (resolved.rejectedSaved !== undefined) {
		console.warn(
			`[i18n] Unknown locale ${JSON.stringify(next)}; falling back to ${BASE_LOCALE}.`,
		);
	}
	paraglideSetLocale(resolved.locale, { reload: false });
	localeState = resolved.locale;
	syncDocumentLocale(resolved.locale);
	return resolved.locale;
}

export interface InitLocaleOptions {
	/** The persisted preference, read by the caller from its own `$persist` store. */
	saved?: string | undefined;
	/** Defaults to `navigator.language` when a browser is present. */
	navigatorLanguage?: string | undefined;
}

/**
 * Startup: saved preference -> `navigator.language` -> en, then apply it.
 * Synchronous — every namespace is eager, so there is no dictionary fetch to
 * await and no flash of the base locale.
 */
export function initLocale(options: InitLocaleOptions = {}): LocaleCode {
	const navigatorLanguage =
		options.navigatorLanguage ??
		(typeof navigator === "undefined" ? undefined : navigator.language);
	const resolved = resolveInitialLocale(options.saved, navigatorLanguage);
	if (resolved.rejectedSaved !== undefined) {
		console.warn(
			`[i18n] Saved locale ${JSON.stringify(resolved.rejectedSaved)} is not supported; using ${resolved.locale}.`,
		);
	}
	paraglideSetLocale(resolved.locale, { reload: false });
	localeState = resolved.locale;
	syncDocumentLocale(resolved.locale);
	return resolved.locale;
}

/** The paraglide runtime's own view of the locale — for assertions, not for rendering. */
export function getRuntimeLocale(): string {
	return paraglideGetLocale();
}

/**
 * Load a namespace before the view that consumes it renders. A no-op for an
 * eager namespace, so wiring it at a destination/dialog activation point costs
 * nothing until that namespace is flipped to lazy in the loader config.
 */
export async function ensureNamespace(namespace: Namespace): Promise<void> {
	loadingState = true;
	try {
		await registryEnsureNamespace(namespace);
	} finally {
		loadingState = false;
	}
}

/**
 * Message accessor, keyed on the VERBATIM dotted key: `m["live.setup.title"]()`.
 * Reactive by construction — every access reads the locale rune first.
 */
export const m: Readonly<Record<MessageKey, MessageFn>> &
	Readonly<Record<string, MessageFn>> = new Proxy(
	Object.create(null) as Record<string, MessageFn>,
	{
		get(_target, key) {
			// Locale dependency: registers the template that reads any message as a
			// consumer of the locale, which is what makes a switch re-render.
			void localeState;
			if (typeof key !== "string") return undefined;
			return staticMessages[key];
		},
		has(_target, key) {
			return typeof key === "string" && getMessage(key) !== undefined;
		},
		ownKeys() {
			return Reflect.ownKeys(staticMessages);
		},
		getOwnPropertyDescriptor(_target, key) {
			if (typeof key !== "string" || getMessage(key) === undefined)
				return undefined;
			return {
				enumerable: true,
				configurable: true,
				value: staticMessages[key],
			};
		},
	},
) as Readonly<Record<MessageKey, MessageFn>> &
	Readonly<Record<string, MessageFn>>;

/**
 * Dynamic dotted-key resolution for the call sites that hold a key in a variable
 * (backend-emitted `labelKey`/`reasonKey`). Unknown key -> the key itself, which
 * is byte-identical to the legacy per-site resolvers' fallback.
 */
export function resolveMessageKey(
	key: string,
	params?: Record<string, unknown>,
): string {
	void localeState;
	return registryResolveMessageKey(key, params);
}

/** Alias for {@link resolveMessageKey} — the shape the per-site `t` helpers had. */
export const t = resolveMessageKey;
