/*
 * A persistent notification survives to a LATER-CONNECTING client
 * (device-quality-wave3 todo 11b, found on the board).
 *
 * The oRPC adapter's post-auth initial-state push replayed config/status/netif/
 * sensors/sources/capabilities/health — but NOT the persistent notification set.
 * The legacy relay path (`modules/ui/status.ts::sendInitialStatus`) always did.
 *
 * For most persistent notifications the omission is masked: they are raised by a
 * loop that re-evaluates, so the next tick re-broadcasts them. The load-time
 * encoder-mode clamp is the case that breaks — it fires exactly ONCE, during the
 * first `sources` build at BOOT, which is strictly before any browser can be
 * connected. So its notification was stored, was returned by
 * `notifications.getPersistent`, and was NEVER rendered: the panel reads the push
 * cache. Confirmed live on the board — "You're all caught up" while the RPC
 * returned the clamp notification.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
	notificationBroadcast,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { buildInitialNotifications } from "../rpc/procedures/status.procedure.ts";

const NAME = "test-persistent-boot-notification";

describe("initial-state push replays persistent notifications", () => {
	afterEach(() => {
		notificationRemove(NAME);
	});

	test("a persistent notification raised BEFORE a client connects is in the initial push", () => {
		notificationBroadcast(
			NAME,
			"warning",
			"english fallback copy",
			0,
			true,
			true,
			true,
			"notifications.encoderModeClamped",
			{ resolution: "1080p", framerate: 30 },
		);

		const replayed = buildInitialNotifications();
		const found = replayed.show.find((entry) => entry.name === NAME);

		expect(found).toBeDefined();
		// The KEY and PARAMS must survive — the panel renders the localized string,
		// so a replay that dropped them would show the English fallback forever.
		expect(found?.key).toBe("notifications.encoderModeClamped");
		expect(found?.params).toEqual({ resolution: "1080p", framerate: 30 });
		expect(found?.is_persistent).toBe(true);
	});

	test("a removed notification is NOT replayed", () => {
		notificationBroadcast(NAME, "warning", "x", 0, true, true, true);
		expect(buildInitialNotifications().show.some((e) => e.name === NAME)).toBe(
			true,
		);

		notificationRemove(NAME);
		expect(buildInitialNotifications().show.some((e) => e.name === NAME)).toBe(
			false,
		);
	});

	test("a NON-persistent notification is never replayed", () => {
		notificationBroadcast(NAME, "success", "transient", 5, false, true, true);
		expect(buildInitialNotifications().show.some((e) => e.name === NAME)).toBe(
			false,
		);
	});
});
