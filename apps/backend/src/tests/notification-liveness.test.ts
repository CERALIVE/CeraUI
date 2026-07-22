/**
 * Notification liveness / expiry-semantics tests (device-quality-wave2 Todo 23b).
 *
 * The bug: `_notificationIsLive` expired PERSISTENT notifications once their
 * `duration` elapsed — but a persistent notification (shown to every new client,
 * cleared only explicitly) must NEVER time out. Correct semantics:
 *   - persistent  ⇒ no timer expiry, ever (duration does not apply)
 *   - duration    ⇒ only governs non-persistent notifications
 *
 * The integration test drives the real notifications module with an injected
 * clock (`nowMs`); the pure-function suite pins the boundary/skew arithmetic.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { getms } from "../helpers/time.ts";
import {
	NOTIFICATION_LIVES_FOREVER,
	notificationRemaining,
} from "../modules/ui/notification-liveness.ts";
import {
	getPersistentNotifications,
	notificationRemove,
	notificationSend,
} from "../modules/ui/notifications.ts";

const emitted = new Set<string>();

afterEach(() => {
	for (const name of emitted) notificationRemove(name);
	emitted.clear();
});

function sendPersistentWithDuration(name: string, durationSeconds: number) {
	emitted.add(name);
	notificationSend(
		undefined,
		name,
		"warning",
		"a persistent notification with a nonzero duration",
		durationSeconds,
		true, // isPersistent
		true, // isDismissable
		true, // authedOnly
	);
}

describe("persistent notifications never expire on a timer", () => {
	it("stays live well past its duration (the F13 expiry bug)", () => {
		const name = "persistent_never_expires";
		const before = getms();
		sendPersistentWithDuration(name, 5);

		// Simulate 60s later — far past the 5s duration.
		const future = before + 60_000;
		const { show } = getPersistentNotifications(true, future);
		const entry = show.find((s) => s.name === name);

		// A persistent notification MUST still be present. Under the pre-fix
		// semantics `_notificationIsLive` returns false here (expired) and drops it.
		expect(entry).toBeDefined();
	});

	it("a persistent notification with duration=0 also stays live (unchanged)", () => {
		const name = "persistent_zero_duration";
		const before = getms();
		sendPersistentWithDuration(name, 0);

		const { show } = getPersistentNotifications(true, before + 60_000);
		expect(show.find((s) => s.name === name)).toBeDefined();
	});
});

describe("notificationRemaining — pure boundary arithmetic (non-persistent)", () => {
	it("persistent ⇒ never expires regardless of elapsed time or duration", () => {
		expect(
			notificationRemaining({
				isPersistent: true,
				duration: 5,
				updatedMs: 0,
				nowMs: 1_000_000,
			}),
		).toBe(NOTIFICATION_LIVES_FOREVER);
	});

	it("non-persistent duration=0 ⇒ never expires", () => {
		expect(
			notificationRemaining({
				isPersistent: false,
				duration: 0,
				updatedMs: 0,
				nowMs: 1_000_000,
			}),
		).toBe(NOTIFICATION_LIVES_FOREVER);
	});

	it("is still live one tick before the duration boundary", () => {
		// 4.999s elapsed of a 5s countdown → 1 whole second remains (ceil).
		expect(
			notificationRemaining({
				isPersistent: false,
				duration: 5,
				updatedMs: 0,
				nowMs: 4_999,
			}),
		).toBe(1);
	});

	it("expires at EXACTLY the duration boundary", () => {
		// 5.000s elapsed of a 5s countdown → expired.
		expect(
			notificationRemaining({
				isPersistent: false,
				duration: 5,
				updatedMs: 0,
				nowMs: 5_000,
			}),
		).toBe(false);
	});

	it("is expired past the duration boundary", () => {
		expect(
			notificationRemaining({
				isPersistent: false,
				duration: 5,
				updatedMs: 0,
				nowMs: 6_000,
			}),
		).toBe(false);
	});

	it("mid-duration restart (updatedMs re-seeded) resumes a full countdown", () => {
		// A restart re-creates the notification with updatedMs = restart time, so
		// the remaining time is measured from the restart, not the original send.
		const restartMs = 100_000;
		expect(
			notificationRemaining({
				isPersistent: false,
				duration: 10,
				updatedMs: restartMs,
				nowMs: restartMs + 3_000,
			}),
		).toBe(7);
	});

	it("tolerates backwards clock skew without premature expiry", () => {
		// nowMs < updatedMs (clock jumped backwards) → never returns false.
		const result = notificationRemaining({
			isPersistent: false,
			duration: 5,
			updatedMs: 10_000,
			nowMs: 2_000,
		});
		expect(result).not.toBe(false);
		expect(typeof result).toBe("number");
	});
});
