/**
 * Task 10 — central notification store (runes).
 *
 * Mirrors the `hud.svelte.ts` / `connection-ux.svelte.ts` testing split: all
 * decision logic lives in *pure*, rune-free functions
 * ({@link resolveNotificationText}, {@link toActiveNotification},
 * {@link pushNotification}, {@link dismissNotification}) that are fully
 * exercisable under the plain (non-Svelte) vitest environment. The reactive
 * runes wrapper is never executed here.
 *
 * `notifications.svelte.ts` statically imports `@ceraui/i18n/svelte`, whose
 * module body declares Svelte runes ($state). Mock it so importing the store
 * never evaluates those runes; the pure resolver under test receives an
 * explicit `translations` tree rather than reading the live `$LL`.
 */
import type { Notification } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ceraui/i18n/svelte", () => ({
	getLL: vi.fn(() => ({})),
}));

import { getLL } from "@ceraui/i18n/svelte";
import {
	type ActiveNotification,
	clearNotifications,
	destroyNotificationStore,
	dismiss,
	dismissNotification,
	getActive,
	push,
	pushNotification,
	resolveNotificationText,
	toActiveNotification,
} from "./notifications.svelte";

// ============================================
// Fixtures
// ============================================

const T0 = 1_000_000;

function makeNotification(overrides: Partial<Notification> = {}): Notification {
	return {
		name: "jetson-undervoltage",
		type: "warning",
		msg: "System undervoltage detected",
		is_dismissable: true,
		is_persistent: false,
		duration: 5,
		...overrides,
	};
}

/** A minimal stand-in for the `$LL` translation tree (nested + interpolating). */
const translations = {
	notifications: {
		jetsonUndervoltage: () => "Undervoltage (localized)",
		appUpdatedDescription: (
			params?: Record<string, string | number | boolean>,
		) => `Updated to version ${params?.version ?? "?"}`,
	},
};

// ============================================
// resolveNotificationText
// ============================================

describe("resolveNotificationText", () => {
	it("resolves a defined key against the translation tree", () => {
		const text = resolveNotificationText(
			makeNotification({ key: "notifications.jetsonUndervoltage" }),
			translations,
		);
		expect(text).toBe("Undervoltage (localized)");
	});

	it("falls back to `msg` when `key` is undefined", () => {
		const text = resolveNotificationText(
			makeNotification({ key: undefined, msg: "Raw fallback message" }),
			translations,
		);
		expect(text).toBe("Raw fallback message");
	});

	it("falls back to `msg` when `key` is not present in the tree", () => {
		const text = resolveNotificationText(
			makeNotification({
				key: "notifications.doesNotExist",
				msg: "Raw fallback",
			}),
			translations,
		);
		expect(text).toBe("Raw fallback");
	});

	it("interpolates `params` into the resolved key", () => {
		const text = resolveNotificationText(
			makeNotification({
				key: "notifications.appUpdatedDescription",
				params: { version: "1.2.3" },
			}),
			translations,
		);
		expect(text).toBe("Updated to version 1.2.3");
	});

	it("handles neither a valid `key` nor `msg` gracefully (key undefined, msg empty)", () => {
		const text = resolveNotificationText(
			makeNotification({ key: undefined, msg: "" }),
			translations,
		);
		expect(text).toBe("");
	});

	it("falls back to empty `msg` when `key` is present but absent from the tree", () => {
		const text = resolveNotificationText(
			makeNotification({ key: "notifications.doesNotExist", msg: "" }),
			translations,
		);
		expect(text).toBe("");
	});
});

// ============================================
// toActiveNotification — duration seconds → ms
// ============================================

describe("toActiveNotification", () => {
	it("converts `duration` seconds → ms with * 1000 (5 → 5000, NOT 12500)", () => {
		const active = toActiveNotification(
			makeNotification({ duration: 5 }),
			translations,
			T0,
		);
		expect(active.durationMs).toBe(5000);
		expect(active.durationMs).not.toBe(12500);
	});

	it("carries persistent vs transient flags through unchanged", () => {
		const persistent = toActiveNotification(
			makeNotification({ is_persistent: true }),
			translations,
			T0,
		);
		const transient = toActiveNotification(
			makeNotification({ is_persistent: false }),
			translations,
			T0,
		);
		expect(persistent.isPersistent).toBe(true);
		expect(transient.isPersistent).toBe(false);
	});

	it("preserves name, type, dismissable flag and receivedAt", () => {
		const active = toActiveNotification(
			makeNotification({
				name: "hdmi-error",
				type: "error",
				is_dismissable: false,
			}),
			translations,
			T0,
		);
		expect(active.name).toBe("hdmi-error");
		expect(active.type).toBe("error");
		expect(active.isDismissable).toBe(false);
		expect(active.receivedAt).toBe(T0);
	});
});

// ============================================
// pushNotification — dedup by name
// ============================================

describe("pushNotification", () => {
	it("dedups by `name`: the same name twice yields one active entry", () => {
		let active: Map<string, ActiveNotification> = new Map();
		active = pushNotification(
			active,
			makeNotification({ msg: "first" }),
			translations,
			T0,
		);
		active = pushNotification(
			active,
			makeNotification({ msg: "second" }),
			translations,
			T0 + 1,
		);

		expect(active.size).toBe(1);
		expect(active.get("jetson-undervoltage")?.text).toBe("second");
	});

	it("keeps distinct names as separate entries", () => {
		let active: Map<string, ActiveNotification> = new Map();
		active = pushNotification(
			active,
			makeNotification({ name: "a" }),
			translations,
			T0,
		);
		active = pushNotification(
			active,
			makeNotification({ name: "b" }),
			translations,
			T0,
		);

		expect(active.size).toBe(2);
		expect([...active.keys()]).toEqual(["a", "b"]);
	});

	it("does not mutate the input map (returns a new map)", () => {
		const input: Map<string, ActiveNotification> = new Map();
		const output = pushNotification(
			input,
			makeNotification(),
			translations,
			T0,
		);
		expect(input.size).toBe(0);
		expect(output.size).toBe(1);
	});
});

// ============================================
// dismissNotification
// ============================================

describe("dismissNotification", () => {
	it("removes the named entry", () => {
		let active: Map<string, ActiveNotification> = new Map();
		active = pushNotification(
			active,
			makeNotification({ name: "a" }),
			translations,
			T0,
		);
		active = pushNotification(
			active,
			makeNotification({ name: "b" }),
			translations,
			T0,
		);

		active = dismissNotification(active, "a");
		expect(active.has("a")).toBe(false);
		expect(active.has("b")).toBe(true);
		expect(active.size).toBe(1);
	});

	it("is a no-op for an unknown name (returns an equivalent map)", () => {
		let active: Map<string, ActiveNotification> = new Map();
		active = pushNotification(
			active,
			makeNotification({ name: "a" }),
			translations,
			T0,
		);

		active = dismissNotification(active, "missing");
		expect(active.size).toBe(1);
		expect(active.has("a")).toBe(true);
	});

	it("does not mutate the input map", () => {
		let input: Map<string, ActiveNotification> = new Map();
		input = pushNotification(
			input,
			makeNotification({ name: "a" }),
			translations,
			T0,
		);
		const output = dismissNotification(input, "a");
		expect(input.has("a")).toBe(true);
		expect(output.has("a")).toBe(false);
	});
});

// ============================================
// Reactive store public API (push / dismiss / getActive / clear)
// ============================================
//
// The pure suites above pass `translations` explicitly so they never touch
// `$LL`. This suite drives the runes store end-to-end, where `push()` resolves
// text via the live `getLL()` — mocked here to a real tree so we assert keys
// resolve to translated strings instead of leaking raw key strings.

describe("notification store (reactive API)", () => {
	beforeEach(() => {
		vi.mocked(getLL).mockReturnValue(translations);
		clearNotifications();
	});

	afterEach(() => {
		destroyNotificationStore();
		vi.mocked(getLL).mockReturnValue({});
	});

	it("dedups by `name`: pushing the same name twice yields one active entry", () => {
		push(makeNotification({ msg: "first" }));
		push(makeNotification({ msg: "second" }));

		const active = getActive();
		expect(active.length).toBe(1);
		expect(active[0]?.name).toBe("jetson-undervoltage");
	});

	it("resolves `key` via the mocked `$LL` with `params` (not the raw key string)", () => {
		push(
			makeNotification({
				name: "app-updated",
				key: "notifications.appUpdatedDescription",
				params: { version: "1.2.3" },
				msg: "Updated",
			}),
		);

		const entry = getActive().find((n) => n.name === "app-updated");
		expect(entry?.text).toBe("Updated to version 1.2.3");
		expect(entry?.text).not.toBe("notifications.appUpdatedDescription");
	});

	it("falls back to `msg` when `key` is undefined (persistent backward-compat replay)", () => {
		push(
			makeNotification({
				name: "legacy",
				key: undefined,
				msg: "Raw persistent message",
				is_persistent: true,
			}),
		);

		const entry = getActive().find((n) => n.name === "legacy");
		expect(entry?.text).toBe("Raw persistent message");
		expect(entry?.isPersistent).toBe(true);
	});

	it("converts `duration` seconds → ms (5 → 5000, NOT 12500) through the store", () => {
		push(makeNotification({ name: "dur", duration: 5 }));

		const entry = getActive().find((n) => n.name === "dur");
		expect(entry?.durationMs).toBe(5000);
		expect(entry?.durationMs).not.toBe(12500);
	});

	it("carries persistent vs transient flags through the store unchanged", () => {
		push(makeNotification({ name: "persists", is_persistent: true }));
		push(makeNotification({ name: "fleeting", is_persistent: false }));

		const active = getActive();
		expect(active.find((n) => n.name === "persists")?.isPersistent).toBe(true);
		expect(active.find((n) => n.name === "fleeting")?.isPersistent).toBe(false);
	});

	it("dismiss(name) removes the entry from getActive()", () => {
		push(makeNotification({ name: "a" }));
		push(makeNotification({ name: "b" }));
		expect(getActive().length).toBe(2);

		dismiss("a");

		const active = getActive();
		expect(active.length).toBe(1);
		expect(active.some((n) => n.name === "a")).toBe(false);
		expect(active.some((n) => n.name === "b")).toBe(true);
	});

	it("folds in a notification with neither a valid `key` nor `msg` without crashing", () => {
		expect(() =>
			push(makeNotification({ name: "empty", key: undefined, msg: "" })),
		).not.toThrow();

		const entry = getActive().find((n) => n.name === "empty");
		expect(entry).toBeDefined();
		expect(entry?.text).toBe("");
	});

	it("clearNotifications() empties getActive()", () => {
		push(makeNotification({ name: "a" }));
		push(makeNotification({ name: "b" }));
		expect(getActive().length).toBe(2);

		clearNotifications();
		expect(getActive().length).toBe(0);
	});
});
