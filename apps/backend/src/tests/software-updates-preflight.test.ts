import { describe, expect, test } from "bun:test";
import { UPDATE_PREFLIGHT_REASONS } from "@ceraui/rpc";
import {
	buildAptUpgradeArgs,
	getSoftUpdateStatus,
	getUpdateState,
	isUpdating,
	runUpdateDiscoveryAndReport,
	setSoftwareUpdateCheckRunner,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

describe("async update preflight", () => {
	test.each([...UPDATE_PREFLIGHT_REASONS])(
		"preserves the armed marker and launches nothing on %s",
		async (reason) => {
			// Given a genuinely armed on-disk stream marker and one unusable input.
			await using h = await updateHarness();
			h.failure = reason;
			// When the synchronous start is accepted and its check continuation runs.
			expect(startSoftwareUpdate()).toEqual({ started: true });
			await h.check();
			// Then no stamp, transaction, or overlay survives the typed refusal.
			expect(await h.marker()).toBe(h.markerBefore);
			expect(h.launches).toEqual([]);
			expect(getUpdateState()).toEqual({
				kind: "update_preflight_failed",
				preflight_reason: reason,
			});
			expect(getSoftUpdateStatus()).toBeNull();
			expect(isUpdating()).toBe(false);
			expect(
				h.frames.filter(
					(frame) => frame.update_state?.kind === "update_preflight_failed",
				),
			).toEqual([
				{
					updating: null,
					update_state: {
						kind: "update_preflight_failed",
						preflight_reason: reason,
					},
				},
			]);
		},
	);

	test("leaves the marker unchanged when the preceding update check fails", async () => {
		// Given an armed marker; when refresh fails; then admission never runs or stamps it.
		await using h = await updateHarness();
		startSoftwareUpdate();
		await h.check(true);
		expect(await h.marker()).toBe(h.markerBefore);
		expect(h.commands).toEqual([]);
		expect(h.launches).toEqual([]);
	});

	test.each(["any", "force_ipv4", "force_ipv6"] as const)(
		"stamps before launch and reuses the single probe argv for %s",
		async (verdict) => {
			// Given a admitted same-volume fixture with a selected family.
			await using h = await updateHarness();
			h.verdict = verdict;
			// When the continuation starts the detached transaction.
			startSoftwareUpdate();
			await h.check();
			// Then the positive stamp and unchanged vector prove the negative marker cases are not vacuous.
			expect(h.markerAtLaunch).toBe(true);
			expect(
				h.commands.filter((argv) => argv.includes("--print-uris")),
			).toEqual([
				[
					"/usr/bin/apt-get",
					"--print-uris",
					...buildAptUpgradeArgs(["cerastream"], verdict),
				],
			]);
			expect(h.launches).toEqual([
				buildAptUpgradeArgs(["cerastream"], verdict),
			]);
			expect(h.commands[h.commands.length - 1]).toEqual([
				"/usr/bin/apt-get",
				"clean",
			]);
			expect(h.cleanCount).toBe(2);
		},
	);

	test("returns started while pre-clean is still blocked", async () => {
		// Given a clean waiting on the OS, with an eventual honest refusal.
		await using h = await updateHarness();
		const gate = Promise.withResolvers<void>();
		h.beforeClean = () => gate.promise;
		h.failure = "pre_clean_failed";
		// When start returns synchronously, its continuation still owns the wait.
		const outcome = startSoftwareUpdate();
		const continuation = h.check();
		expect(outcome).toEqual({ started: true });
		expect(await h.marker()).toBe(h.markerBefore);
		expect(h.launches).toEqual([]);
		gate.resolve();
		await continuation;
	});

	test("hydrates a reconnect with the terminal and explicit absent overlay", async () => {
		// Given a finished refusal; when a new client asks for initial status; then it cannot relatch progress.
		await using h = await updateHarness();
		h.failure = "insufficient_space";
		startSoftwareUpdate();
		await h.check();
		expect(buildInitialStatus().status).toMatchObject({
			updating: null,
			update_state: {
				kind: "update_preflight_failed",
				preflight_reason: "insufficient_space",
			},
		});
	});

	test("retains the preflight terminal across a refused manual check and background discovery", async () => {
		// Given a standing preflight refusal.
		await using h = await updateHarness();
		h.failure = "statfs_failed";
		startSoftwareUpdate();
		await h.check();
		setSoftwareUpdateCheckRunner(() => false);
		const {
			triggerManualUpdateCheck,
			setSoftwareUpdateSizeRunner,
			resetSoftwareUpdateSizeRunner,
		} = await import("../modules/system/software-updates.ts");
		setSoftwareUpdateSizeRunner(async () => null);
		try {
			// When both kinds of non-superseding check occur; then the terminal stands.
			expect(triggerManualUpdateCheck()).toBe(false);
			await runUpdateDiscoveryAndReport();
			expect(getUpdateState()).toEqual({
				kind: "update_preflight_failed",
				preflight_reason: "statfs_failed",
			});
		} finally {
			resetSoftwareUpdateSizeRunner();
		}
	});
});
