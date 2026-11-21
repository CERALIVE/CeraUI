import { describe, expect, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { cleanAptCache } from "../modules/system/apt-cache-clean.ts";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
import { recoverDetachedAptUpgrade } from "../modules/system/software-update-process.ts";
import { parseDetachedAptServiceState } from "../modules/system/software-update-service.ts";
import {
	getUpdateState,
	isUpdating,
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setSoftwareUpdateCheckRunner,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import {
	getPersistentNotifications,
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

describe("update availability notification", () => {
	test("withdraws the installed offer from connected clients and reconnect replay", async () => {
		await using h = await updateHarness();
		const broadcast = spyOn(websocket, "broadcastMsg");
		notificationBroadcast(
			"update-test-other",
			"warning",
			"Other notice",
			0,
			true,
		);
		try {
			expect(notificationExists("ceralive_update")).toBeDefined();
			h.completion = Promise.resolve(0);
			startSoftwareUpdate();
			await h.check();

			expect(
				getPersistentNotifications(true).show.map(({ name }) => name),
			).not.toContain("ceralive_update");
			expect(notificationExists("update-test-other")).toBeDefined();
			expect(broadcast.mock.calls.map(([, payload]) => payload)).toContainEqual(
				{
					remove: [{ id: "ceralive_update", revision: expect.any(Number) }],
				},
			);
		} finally {
			broadcast.mockRestore();
			notificationRemove("ceralive_update");
			notificationRemove("update-test-other");
		}
	});

	test.each([
		["no upgrades", "0 upgraded, 0 newly installed, 0 to remove.\n"],
		[
			"only a platform upgrade",
			"The following packages will be upgraded:\n  linux-image-edge-rockchip-rk3588\n1 upgraded, 0 newly installed, 0 to remove.\nNeed to get 4 kB of archives.\n",
		],
	])("withdraws the offer when discovery finds %s", async (_name, stdout) => {
		await using _h = await updateHarness();
		expect(notificationExists("ceralive_update")).toBeDefined();
		const discovery = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
			exitCode: 0,
			stdout,
			stderr: "",
		});
		try {
			await runUpdateDiscoveryAndReport();
			expect(notificationExists("ceralive_update")).toBeUndefined();
		} finally {
			discovery.mockRestore();
			notificationRemove("ceralive_update");
		}
	});
});

describe("best-effort post-clean", () => {
	test.each([false, true])(
		"keeps a successful transaction successful when cleanup fails=%s",
		async (postCleanFails) => {
			// Given a successful package transaction; when cleanup settles; then its verdict never changes.
			await using h = await updateHarness();
			h.completion = Promise.resolve(0);
			h.postCleanFails = postCleanFails;
			startSoftwareUpdate();
			await h.check();
			expect(getUpdateState()).toEqual(
				postCleanFails
					? { kind: "success", cleanup_warning: "post_clean_failed" }
					: { kind: "success" },
			);
			expect(h.cleanCount).toBe(2);
			expect(h.restarts).toBe(1);
		},
	);
	test("legacy completion keeps its original exit without calling the orchestrator hook", async () => {
		await using h = await updateHarness();
		h.completion = Promise.resolve(0);
		let hookCalls = 0;

		startSoftwareUpdate(() => {
			hookCalls++;
		});
		await h.check();

		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(hookCalls).toBe(0);
		expect(h.restarts).toBe(1);
	});
	test("preserves the original transaction failure when post-clean also fails", async () => {
		// Given an install error; when post-clean fails too; then it must not mask the original reason.
		await using h = await updateHarness();
		h.postCleanFails = true;
		startSoftwareUpdate();
		await h.check();
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "original transaction failure",
		});
		expect(h.cleanCount).toBe(2);
		expect(h.restarts).toBe(0);
	});
	test("holds the update latch and restart until the terminal transaction's post-clean settles", async () => {
		// Given a clean held after the transaction result, never before it.
		await using h = await updateHarness();
		const transaction = Promise.withResolvers<number>();
		const cleaning = Promise.withResolvers<"clean">();
		const release = Promise.withResolvers<void>();
		h.completion = transaction.promise;
		h.beforeClean = async () => {
			if (h.cleanCount === 2) {
				cleaning.resolve("clean");
				await release.promise;
			}
		};
		// When the transaction completes; then cleanup precedes terminal publication and restart.
		startSoftwareUpdate();
		const continuation = h.check();
		transaction.resolve(0);
		try {
			expect(
				await Promise.race([
					cleaning.promise,
					h.settled().then(() => "terminal"),
				]),
			).toBe("clean");
			expect(isUpdating()).toBe(true);
			expect(h.restarts).toBe(0);
			expect(startSoftwareUpdate()).toEqual({
				started: false,
				reason: "already_updating",
			});
		} finally {
			release.resolve();
			await continuation;
		}
	});
	test("post-cleans a recovered transaction through the same completion path", async () => {
		// Given a retained successful unit; when recovery observes completion; then only post-clean runs.
		await using h = await updateHarness();
		h.cleanCount = 1;
		h.postCleanFails = true;
		await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return { completion: Promise.resolve(0), wasAlreadyFinished: true };
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		await h.settled();
		expect(h.commands).toEqual([["/usr/bin/apt-get", "clean"]]);
		expect(h.launches).toEqual([]);
		expect(getUpdateState()).toEqual({
			kind: "success",
			cleanup_warning: "post_clean_failed",
		});
	});
	test("cannot recover a direct clean as an update after a backend restart", async () => {
		// Given a live direct clean which created no transient unit.
		await using h = await updateHarness();
		const release = Promise.withResolvers<void>();
		h.beforeClean = () => release.promise;
		const clean = cleanAptCache(defaultAptSpaceDeps.run);
		let attached = false;
		// When the new backend probes the unchanged unit identity; then nothing is adopted.
		try {
			const recovered = await recoverDetachedAptUpgrade(
				{
					onAttached: () => {
						attached = true;
					},
					onStdout: () => {},
					onStderr: () => {},
				},
				{
					outputPaths: {
						stdout: "/run/ceralive/software-update.stdout",
						stderr: "/run/ceralive/software-update.stderr",
					},
					inspect: async () =>
						parseDetachedAptServiceState(
							"LoadState=not-found\nActiveState=inactive\n",
						),
					prepareOutput: async () => {
						throw new Error("must not prepare");
					},
					start: async () => {
						throw new Error("must not start");
					},
					cleanup: async () => {
						throw new Error("must not clean unit");
					},
					readOutput: async () => {
						throw new Error("must not read output");
					},
					sleep: async () => {
						throw new Error("must not observe");
					},
				},
			);
			expect(recovered).toBeNull();
			expect(attached).toBe(false);
			expect(h.commands).toEqual([["/usr/bin/apt-get", "clean"]]);
			expect(h.restarts).toBe(0);
		} finally {
			release.resolve();
			await clean;
		}
	});
});

describe.each(["preflight", "warning"] as const)(
	"terminal lifetime: %s",
	(terminal) => {
		async function standing() {
			const h = await updateHarness();
			if (terminal === "preflight") h.failure = "insufficient_space";
			else {
				h.completion = Promise.resolve(0);
				h.postCleanFails = true;
			}
			startSoftwareUpdate();
			await h.check();
			try {
				expect(getUpdateState()).toEqual(
					terminal === "preflight"
						? {
								kind: "update_preflight_failed",
								preflight_reason: "insufficient_space",
							}
						: { kind: "success", cleanup_warning: "post_clean_failed" },
				);
			} catch (error) {
				await h[Symbol.asyncDispose]();
				throw error;
			}
			return h;
		}
		test("clears on the next accepted install attempt", async () => {
			// Given a terminal; when another install starts; then it cannot inherit either slot.
			await using h = await standing();
			h.next();
			startSoftwareUpdate();
			expect(getUpdateState().kind).toBe("downloading");
			await h.check();
		});
		test("clears on an accepted manual re-check", async () => {
			// Given a terminal; when manual dispatch accepts; then availability replaces the old result.
			await using _h = await standing();
			expect(triggerManualUpdateCheck()).toBe(true);
			expect(getUpdateState().kind).toBe("available");
		});
		test("clears on explicit reset", async () => {
			// Given a terminal; when reset explicitly retires the run; then neither slot survives.
			await using _h = await standing();
			resetSoftwareUpdateState();
			expect(getUpdateState().kind).toBe("available");
		});
		test("survives a refused manual check", async () => {
			// Given a terminal; when dispatch refuses; then it has replaced nothing.
			await using _h = await standing();
			const before = getUpdateState();
			setSoftwareUpdateCheckRunner(() => false);
			expect(triggerManualUpdateCheck()).toBe(false);
			expect(getUpdateState()).toEqual(before);
		});
	},
);
