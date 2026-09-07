import { expect, test } from "bun:test";
import { deriveUpdateState } from "../modules/system/update-state.ts";

test("preflight terminal outranks stale progress", () => {
	// Given stale progress plus a completed refusal; when reduced; then the terminal wins.
	expect(
		deriveUpdateState({
			checking: false,
			available: null,
			updating: { total: 1, downloading: 0, unpacking: 0, setting_up: 0 },
			failure: null,
			succeeded: false,
			preflightFailure: "stat_failed",
		}),
	).toEqual({
		kind: "update_preflight_failed",
		preflight_reason: "stat_failed",
	});
});

test("cleanup warning is scoped to the most recent success", () => {
	// Given a successful run with failed cleanup; when reduced; then success carries only its own warning.
	expect(
		deriveUpdateState({
			checking: false,
			available: null,
			updating: null,
			failure: null,
			succeeded: true,
			cleanupWarning: "post_clean_failed",
		}),
	).toEqual({ kind: "success", cleanup_warning: "post_clean_failed" });
});
