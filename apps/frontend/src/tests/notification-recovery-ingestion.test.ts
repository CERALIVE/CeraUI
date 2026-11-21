/**
 * Regression lock: a backend `remove` frame must drop the notification from the
 * PERSISTENT panel, not just the transient toast stream.
 *
 * The two raise-only notifications this covers — `hdmi_error` ("No HDMI signal
 * detected") and the `cerastream` channel carrying `capture_video_error` — never
 * emitted a `remove` at all, so the panel entry outlived the condition for the
 * whole session. The backend half now retracts on real recovery evidence; this
 * pins the frontend half that makes the retraction visible, driven through the
 * REAL `subscriptions.svelte` ingestion handler rather than the store directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	clearNotifications,
	getPersistent,
} from "$lib/stores/notifications.svelte";

function show(name: string, msg: string, revision: number): void {
	handlers.message?.("notification", {
		show: [
			{
				name,
				type: "error",
				msg,
				is_dismissable: true,
				is_persistent: true,
				duration: 0,
				revision,
			},
		],
	});
}

function remove(name: string, revision: number): void {
	handlers.message?.("notification", { remove: [{ id: name, revision }] });
}

function persistentNames(): string[] {
	return getPersistent().map((n) => n.name);
}

describe("persistent notifications are retractable", () => {
	beforeEach(() => {
		resetState();
		clearNotifications();
		initSubscriptions();
	});

	it("drops hdmi_error from the panel when the backend retracts it", () => {
		show("hdmi_error", "No HDMI signal detected", 1);
		expect(persistentNames()).toContain("hdmi_error");

		remove("hdmi_error", 2);

		expect(persistentNames()).not.toContain("hdmi_error");
	});

	it("drops the cerastream capture error from the panel when the backend retracts it", () => {
		show(
			"cerastream",
			"Capture card error (video). No automatic restart is scheduled.",
			1,
		);
		expect(persistentNames()).toContain("cerastream");

		remove("cerastream", 2);

		expect(persistentNames()).not.toContain("cerastream");
	});

	it("retracts only the named notification, leaving the rest of the panel intact", () => {
		show("hdmi_error", "No HDMI signal detected", 1);
		show("no_internet", "No internet connection", 2);

		remove("hdmi_error", 3);

		expect(persistentNames()).toEqual(["no_internet"]);
	});
});
