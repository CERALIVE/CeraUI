// @vitest-environment jsdom
/**
 * FieldSyncIndicator — reactive sync-state affordance (Task 5).
 *
 * Drives the live sync-state machine through its lifecycle and asserts the
 * component renders the right chrome at each phase — most importantly that the
 * InlineSpinner (role="status") appears during `applying` and nowhere else. This
 * exercises the REACTIVE layer of `field-sync-state.svelte.ts` (the runes wrapper
 * the pure-core suite never touches) and its composition with the dirty-registry.
 */

import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { destroyDirtyRegistry } from "$lib/rpc/dirty-registry.svelte";
import {
	beginFieldSync,
	destroyFieldSyncState,
	getFieldState,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from "$lib/rpc/field-sync-state.svelte";

import FieldSyncIndicator from "./FieldSyncIndicator.svelte";

beforeEach(() => {
	// Warm the lazy singleton before mount: if it's created during the component's
	// first render, jsdom + flushSync miss later external mutations. (Real browsers
	// flush on their own microtask, so this is a test-determinism aid only.)
	getFieldState("__warmup__");
});

afterEach(() => {
	// Reset both singletons (and their sweep timers) so each test starts clean.
	destroyFieldSyncState();
	destroyDirtyRegistry();
});

function mount(field: string) {
	return render(FieldSyncIndicator, {
		props: {
			field,
			applyingLabel: "Applying…",
			appliedLabel: "Applied",
			failedLabel: "Failed",
			"data-testid": "indicator",
		},
	});
}

describe("FieldSyncIndicator", () => {
	it("renders nothing while idle", () => {
		const { container } = mount("max_br");
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it("shows the InlineSpinner (role=status) only during applying", () => {
		const { container } = mount("max_br");

		// pending: edit registered, RPC not yet dispatched — no spinner.
		beginFieldSync("max_br", 8000);
		flushSync();
		expect(container.querySelector('[role="status"]')).toBeNull();

		// applying: the spinner appears with its in-flight label.
		markFieldApplying("max_br");
		flushSync();
		const status = container.querySelector('[role="status"]');
		expect(status).not.toBeNull();
		expect(status?.textContent).toContain("Applying…");
	});

	it("swaps the spinner for the applied affordance on resolve", () => {
		const { container } = mount("max_br");
		beginFieldSync("max_br", 8000);
		markFieldApplying("max_br");
		flushSync();

		markFieldApplied("max_br", 6000);
		flushSync();

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toContain("Applied");
		// No longer "applying" — the spinner glyph is gone.
		expect(status?.textContent).not.toContain("Applying…");
	});

	it("shows the failed affordance on reject", () => {
		const { container } = mount("max_br");
		beginFieldSync("max_br", 8000);
		markFieldApplying("max_br");
		flushSync();

		markFieldFailed("max_br", 4000);
		flushSync();

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toContain("Failed");
	});

	it("never renders for an excluded status field (G4)", () => {
		const { container } = mount("is_streaming");

		// beginFieldSync refuses the status field, so nothing ever enters applying.
		expect(beginFieldSync("is_streaming", true)).toBe(false);
		markFieldApplying("is_streaming");
		flushSync();
		expect(container.querySelector('[role="status"]')).toBeNull();
	});
});
