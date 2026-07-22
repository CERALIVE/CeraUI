/**
 * Durable dismissal wiring (device-quality-wave2 Todo 23d).
 *
 * Dismissing a persistent notification that carries a semantic dismissal key must
 * suppress it on a later re-emit (page reload) AND after a backend restart — the
 * old in-memory Map did neither. Keyed by semantic identity, so a NEW version's
 * notification is NOT suppressed by the OLD version's dismissal.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationDismiss,
	notificationRemove,
	notificationSend,
} from "../modules/ui/notifications.ts";

let dir: string;
const emitted = new Set<string>();

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceraui-dismiss-wire-"));
	process.env.CERALIVE_DISMISSALS_FILE = path.join(dir, "dismissals.json");
	resetDismissalStoreForTests();
});

afterEach(() => {
	for (const name of emitted) notificationRemove(name);
	emitted.clear();
	resetDismissalStoreForTests();
	process.env.CERALIVE_DISMISSALS_FILE = undefined;
	fs.rmSync(dir, { recursive: true, force: true });
});

function isShown(name: string): boolean {
	return getPersistentNotifications(true).show.some((s) => s.name === name);
}

function sendUpdate(version: string) {
	emitted.add("software_update");
	notificationSend(
		undefined,
		"software_update",
		"success",
		`Update ${version} available`,
		0,
		true,
		true,
		true,
		undefined,
		undefined,
		{ dismissalKey: `update:${version}` },
	);
}

describe("durable dismissal wiring", () => {
	it("suppresses a re-emit after dismissal (page reload)", () => {
		sendUpdate("2026.7.3");
		expect(isShown("software_update")).toBe(true);

		notificationDismiss("software_update");
		expect(isShown("software_update")).toBe(false);

		// Producer re-emits the SAME semantic identity (e.g. periodic apt check).
		sendUpdate("2026.7.3");
		expect(isShown("software_update")).toBe(false);
	});

	it("survives a backend restart (store reloaded from disk)", () => {
		sendUpdate("2026.7.3");
		notificationDismiss("software_update");

		// Simulate a restart: drop the in-memory store + notification, reload store
		// from disk on next access.
		notificationRemove("software_update");
		resetDismissalStoreForTests();

		sendUpdate("2026.7.3");
		expect(isShown("software_update")).toBe(false);
	});

	it("a NEW version re-notifies despite the OLD version's dismissal", () => {
		sendUpdate("2026.7.3");
		notificationDismiss("software_update");
		notificationRemove("software_update");

		sendUpdate("2026.7.4");
		expect(isShown("software_update")).toBe(true);
	});

	it("a notification WITHOUT a dismissal key is not durably suppressed", () => {
		emitted.add("hdmi_error");
		const send = () =>
			notificationSend(
				undefined,
				"hdmi_error",
				"error",
				"HDMI signal issues",
				0,
				true,
			);
		send();
		expect(isShown("hdmi_error")).toBe(true);

		notificationDismiss("hdmi_error");
		expect(isShown("hdmi_error")).toBe(false);

		// Re-emit: a keyless notification reappears (current behavior preserved).
		send();
		expect(isShown("hdmi_error")).toBe(true);
	});

	it("the remove message is the typed { id, revision } shape", () => {
		emitted.add("some_note");
		notificationSend(undefined, "some_note", "warning", "note", 0, true);
		const msg = notificationRemove("some_note");
		expect(msg.remove).toHaveLength(1);
		expect(msg.remove[0]?.id).toBe("some_note");
		expect(typeof msg.remove[0]?.revision).toBe("number");
	});
});
