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

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	notificationSchema,
	notificationsMessageSchema,
} from "@ceraui/rpc/schemas";

import {
	notificationBroadcast,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { buildInitialNotifications } from "../rpc/procedures/status.procedure.ts";

const NAME = "test-persistent-boot-notification";
// With the backend preload's global hooks, Bun 1.4.4 treats a per-test timeout
// of 0 as its 5 s default and SIGTERMs live children, so the test timeout must
// outlast this deadline for the deadline's diagnostics to win.
const CHILD_DEADLINE_MS = 30_000;

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

// A client cannot tell a replayed standing notice from one raised just now, so
// the producer says which frame is the replay and which process numbered it.
describe("the replay and its publisher are on the wire", () => {
	afterEach(() => {
		notificationRemove(NAME);
	});

	test("the initial push is marked as the replay of standing notices", () => {
		notificationBroadcast(NAME, "warning", "x", 0, true, true, true);

		expect(buildInitialNotifications().replay).toBe(true);
	});

	test("a live broadcast is unmarked and names the publisher the replay names", () => {
		const broadcast = spyOn(websocket, "broadcastMsg");
		try {
			notificationBroadcast(NAME, "warning", "x", 0, true, true, true);

			expect(broadcast).toHaveBeenCalledTimes(1);
			const [type, payload] = broadcast.mock.calls[0] ?? [];
			expect(type).toBe("notification");
			const live = notificationsMessageSchema.parse(payload);
			expect(live.replay).toBeUndefined();
			const publisher = live.show?.[0]?.publisher;
			expect(publisher).toBeString();
			expect(publisher).not.toBe("");
			expect(
				buildInitialNotifications().show.find((entry) => entry.name === NAME)
					?.publisher,
			).toBe(publisher);
		} finally {
			broadcast.mockRestore();
		}
	});

	test(
		"two backend processes number the same notice alike but name different publishers",
		async () => {
			// Share one deadline across both children so a hang still yields exit diagnostics.
			const deadline = AbortSignal.timeout(CHILD_DEADLINE_MS);
			const module = new URL("../modules/ui/notifications.ts", import.meta.url)
				.pathname;
			const prefix = "replay-result:";
			const resultSchema = notificationSchema
				.pick({ revision: true, publisher: true })
				.required();
			const probe = [
				`import { getPersistentNotifications, notificationBroadcast } from ${JSON.stringify(module)};`,
				`notificationBroadcast("probe", "warning", "x", 0, true, true, true);`,
				`const [entry] = getPersistentNotifications(true).show;`,
				`console.log(${JSON.stringify(prefix)} + JSON.stringify({ revision: entry.revision, publisher: entry.publisher }));`,
			].join("\n");
			const run = async (label: string) => {
				const child = Bun.spawn([process.execPath, "-e", probe], {
					env: process.env,
					stdout: "pipe",
					stderr: "pipe",
					signal: deadline,
					killSignal: "SIGKILL",
				});
				const [out, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				const line = out.split("\n").find((line) => line.startsWith(prefix));
				const details = `${label} replay child (exit ${code}, signal ${child.signalCode ?? "none"}, result ${line === undefined ? "missing" : "received"}); stderr: ${stderr.trim() || "(empty)"}`;
				if (deadline.aborted)
					throw new Error(`Replay deadline exceeded: ${details}`);
				if (code !== 0 || line === undefined) throw new Error(details);
				try {
					return resultSchema.parse(JSON.parse(line.slice(prefix.length)));
				} catch (cause) {
					throw new Error(`Invalid replay result: ${details}`, { cause });
				}
			};

			const first = await run("first");
			const second = await run("second");

			expect(second.revision).toBe(first.revision);
			expect(first.publisher).toBeString();
			expect(second.publisher).not.toBe(first.publisher);
		},
		CHILD_DEADLINE_MS + 10_000,
	);
});
