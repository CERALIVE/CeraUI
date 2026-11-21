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

	it("a reconnect replay that carries a retained withdrawal drops a standing update offer from an open tab", () => {
		// Given an open tab still showing the offer after the backend restarted.
		show("ceralive_update", "A CeraLive update is available.", 7);
		show("update:updates-available:os:2026.12.0", "Updates are available.", 8);

		// When the new process replays its standing notices with the withdrawal it kept.
		handlers.message?.("notification", {
			replay: true,
			show: [],
			remove: [{ id: "ceralive_update", revision: 1 }],
		});

		// Then only the withdrawn offer leaves; the OS offer on the same surface stays.
		expect(persistentNames()).toEqual([
			"update:updates-available:os:2026.12.0",
		]);
	});

	it("ignores the pre-#183 string removal that accompanies a typed one", () => {
		show("ceralive_update", "A CeraLive update is available.", 7);

		// The device sends this form for older open tabs; this frontend uses the typed frame.
		handlers.message?.("notification", { remove: ["ceralive_update"] });
		expect(persistentNames()).toEqual(["ceralive_update"]);

		remove("ceralive_update", 8);
		expect(persistentNames()).toEqual([]);
	});

	it("retracts only the named notification, leaving the rest of the panel intact", () => {
		show("hdmi_error", "No HDMI signal detected", 1);
		show("no_internet", "No internet connection", 2);

		remove("hdmi_error", 3);

		expect(persistentNames()).toEqual(["no_internet"]);
	});

	it("a scoped removal retires only this lineage's issuances up to its generation", () => {
		const offer = (issuance?: { lineage: string; generation: number }) =>
			handlers.message?.("notification", {
				show: [
					{
						name: "ceralive_update",
						type: "warning",
						msg: "A CeraLive update is available.",
						is_dismissable: true,
						is_persistent: true,
						duration: 0,
						revision: 1,
						...(issuance !== undefined ? { issuance } : {}),
					},
				],
			});
		const removeScoped = (issuance: unknown) =>
			handlers.message?.("notification", {
				remove: [{ id: "ceralive_update", revision: 2, issuance }],
			});
		const scope = { lineage: "lineage-a", generation: 5 };
		// Kept: a copy with no issuance (another producer), another lineage, a newer issuance.
		for (const held of [
			undefined,
			{ lineage: "lineage-b", generation: 1 },
			{ lineage: "lineage-a", generation: 6 },
		]) {
			offer(held);
			removeScoped(scope);
			expect([held, persistentNames()]).toEqual([held, ["ceralive_update"]]);
		}
		// A malformed scope is a malformed frame: nothing is removed.
		removeScoped({ lineage: "lineage-a", generation: "5" });
		expect(persistentNames()).toEqual(["ceralive_update"]);
		// Retired: the scoped issuance and an older one of the same lineage.
		for (const generation of [5, 3]) {
			offer({ lineage: "lineage-a", generation });
			removeScoped(scope);
			expect([generation, persistentNames()]).toEqual([generation, []]);
		}
		// An unscoped removal still removes by name, as every earlier frontend does.
		offer();
		remove("ceralive_update", 3);
		expect(persistentNames()).toEqual([]);
	});
});
