/**
 * lazy-dialog.svelte.ts — the async registry that turns a config dialog into
 * its own chunk.
 *
 * WHY a registry and not a plain `{#await import(...)}`: under rolldown a
 * statically-reachable module cannot be split by NAMING it in `manualChunks`
 * (see `scripts/ci/bundle-report.mjs`), so a dynamic `import()` is the only
 * thing that moves a dialog's bytes out of the entry chunk. Doing that inline
 * at every mount site would also re-fetch on every open, because `{#await}`
 * re-runs its expression — the registry caches the resolved component for the
 * page's lifetime, so the second open is free.
 *
 * The dialogs themselves are UNTOUCHED: this is a bundling change, and a call
 * site keeps its exact `bind:open` (and, for EncoderDialog, `bind:config`)
 * markup. Nothing here may become a place where dialog props are declared.
 *
 * The load is triggered by the mount site the first time its dialog is opened
 * (`LazyDialog.svelte` for the `bind:open`-only dialogs; a one-line `$effect`
 * where a second binding rules the wrapper out).
 */

// A dialog's props differ per dialog, and each is mounted with its own `bind:`
// set, so the registry is deliberately prop-agnostic — the call site's markup
// stays the contract.
// biome-ignore lint/suspicious/noExplicitAny: prop-agnostic by construction; see above
export type LazyDialogComponent = import("svelte").Component<any, any, any>;

/**
 * How long a chunk may take before the loading chrome appears.
 *
 * The fallback exists for a genuinely slow first fetch, NOT for the ordinary
 * path: on the device the SPA is served by the local backend and, after the PWA
 * installs, every dialog chunk is precached — both resolve far inside this
 * window. Rendering the fallback unconditionally would mount and immediately
 * unmount a second bits-ui dialog (portal, focus trap, scroll lock) in front of
 * the real one on every single open, which is a regression risk for exactly the
 * open/close contract this change must not touch.
 */
export const LAZY_DIALOG_FALLBACK_DELAY_MS = 150;

export interface LazyDialogRegistration {
	/** The resolved component, or `undefined` until the chunk lands. */
	readonly current: LazyDialogComponent | undefined;
	/** True once the chunk has been slow enough to deserve loading chrome. */
	readonly pending: boolean;
	/** True when the chunk could not be fetched; the chrome states it. */
	readonly failed: boolean;
	/** Idempotent — the first open starts the fetch, later opens are free. */
	request(): void;
	/** Clears the failure and re-attempts the fetch. */
	retry(): void;
}

export function lazyDialog(
	load: () => Promise<{ default: LazyDialogComponent }>,
): LazyDialogRegistration {
	let component = $state<LazyDialogComponent | undefined>(undefined);
	let pending = $state(false);
	let failed = $state(false);
	let started = false;
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

	const settle = () => {
		if (fallbackTimer !== undefined) {
			clearTimeout(fallbackTimer);
			fallbackTimer = undefined;
		}
	};

	const request = () => {
		if (started || component !== undefined) return;
		started = true;
		failed = false;
		fallbackTimer = setTimeout(() => {
			pending = true;
		}, LAZY_DIALOG_FALLBACK_DELAY_MS);

		void load().then(
			(module) => {
				settle();
				component = module.default;
				pending = false;
			},
			(error: unknown) => {
				settle();
				// A dead button is the one outcome worse than a slow one: surface
				// the failure so the operator can retry rather than re-click into
				// silence.
				started = false;
				failed = true;
				pending = true;
				console.error("[lazy-dialog] dialog chunk failed to load", error);
			},
		);
	};

	return {
		get current() {
			return component;
		},
		get pending() {
			return pending;
		},
		get failed() {
			return failed;
		},
		request,
		retry() {
			failed = false;
			pending = false;
			request();
		},
	};
}
