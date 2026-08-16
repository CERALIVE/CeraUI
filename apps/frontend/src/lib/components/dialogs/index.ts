// Shared dialog framework. AppDialog is the canonical responsive dialog chrome
// that settings / configuration dialogs (Tasks 25-27 onward) compose on top of.
// LazyDialog + lazyDialog() are the async registry that keeps each of those
// dialogs in its own chunk instead of the entry bundle.
export { default as AppDialog } from "./AppDialog.svelte";
export { default as LazyDialog } from "./LazyDialog.svelte";
export { default as LazyDialogFallback } from "./LazyDialogFallback.svelte";
export {
	LAZY_DIALOG_FALLBACK_DELAY_MS,
	type LazyDialogComponent,
	type LazyDialogRegistration,
	lazyDialog,
} from "./lazy-dialog.svelte";
