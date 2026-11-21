import { expect, spyOn, test } from "bun:test";
import type { StatusResponse, UpdateProgress } from "@ceraui/rpc";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import type { DetachedAptUpgradeDeps } from "../modules/system/software-update-process.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import * as updates from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

const realRun = transaction.runDetachedAptAll;
const realRecover = transaction.recoverDetachedAptUpgrade;
const { t, install } = aptEntryHarness();
const paths = softwareUpdateOutputPaths();
const downloading = { total: 1, downloading: 1, unpacking: 0, setting_up: 0 };
const installingAt = (percent: number) => ({
	total: 1,
	downloading: 0,
	unpacking: 0,
	setting_up: 1,
	percent,
});
const pm = (percent: string) =>
	`pmstatus:cerastream:${percent}:Unpacking cerastream\n`;
const rank = (u: UpdateProgress) =>
	(u.setting_up > 0 ? 2 : u.downloading > 0 ? 1 : 0) * 1000 + (u.percent ?? -1);

type Files = { stdout: string; stderr: string; status: string };

// One detached unit seen by successive backend processes: all of them read the
// same growing files, and each poll's sleep runs the next scripted moment.
function unitDeps(
	files: Files,
	o: {
		state: () => "absent" | "running" | "finished";
		exitCode: number;
		steps: (() => Promise<never> | undefined)[];
		onStart?: () => void;
		failFirstStdoutRead?: boolean;
	},
): DetachedAptUpgradeDeps {
	let stdoutReads = 0;
	return {
		outputPaths: paths,
		prepareOutput: async () => {},
		start: async () => o.onStart?.(),
		inspect: async () => {
			const state = o.state();
			if (state === "absent") return { kind: "absent" };
			if (state === "running") return { kind: "running", aptStatus: true };
			return {
				kind: "finished",
				exitCode: o.exitCode,
				cleanup: o.exitCode === 0 ? "stop" : "reset-failed",
				aptStatus: true,
			};
		},
		cleanup: async () => {},
		readOutput: async (path, offset) => {
			const file =
				path === paths.stdout
					? "stdout"
					: path === paths.stderr
						? "stderr"
						: "status";
			if (file === "stdout" && o.failFirstStdoutRead && ++stdoutReads === 1)
				throw new Error("EIO");
			const bytes = Buffer.from(files[file]);
			return { bytes: bytes.subarray(offset), nextOffset: bytes.byteLength };
		},
		sleep: async () => {
			await o.steps.shift()?.();
		},
	};
}

// The Rock 5B+ timeline (2026-11-21): about 7 s of in-process pinned download,
// the unit's cached download stage, dpkg, the package's postinst restarting
// CeraUI while the unit keeps running, re-authentication, recovery, and the
// restart that follows the outcome.
test.each([
	[0, "success"],
	[100, "failed"],
] as const)(
	"an open tab sees steady progress across the postinst restart (exit %d)",
	async (exitCode, terminal) => {
		await withDeviceType("real", async () => {
			const { h, run } = await install([sample("eth0", "ethernet", 6)]);
			await using _h = h;
			let tab: StatusResponse["updating"];
			let connected = true;
			let unitFinished = false;
			const applied: UpdateProgress[] = [];
			const apply = (status: Partial<StatusResponse>) => {
				if (status.updating === undefined) return;
				tab = status.updating;
				const u = typeof tab === "object" ? tab : null;
				if (u && u.result === undefined) applied.push(u);
				if (u?.result !== undefined) expect(unitFinished).toBe(true);
			};
			h.onFrame = (frame) => {
				if (connected) apply(frame);
			};
			const seen: Record<string, unknown> = {};
			const see = (moment: string) => {
				seen[moment] = structuredClone(tab);
			};
			const files: Files = { stdout: "", stderr: "", status: "" };

			// The original backend process.
			const restarted = Promise.withResolvers<void>();
			let stateA: "absent" | "running" = "absent";
			t.download = async () => {
				see("pinned download in flight");
				return {
					exitCode: 0,
					stdout:
						"Get:1 https://apt.invalid trixie/main arm64 cerastream 2 [48 MB]\n",
					stderr: "",
				};
			};
			const depsA = unitDeps(files, {
				state: () => stateA,
				exitCode,
				onStart: () => {
					stateA = "running";
					files.stdout = "Reading package lists...\n";
				},
				steps: [
					() => {
						see("unit cache hit");
						files.stdout +=
							"Preparing to unpack .../cerastream_2_arm64.deb ...\n";
						files.status += `pmstatus:dpkg-exec:0.0000:Running dpkg\n${pm("40.0000")}`;
					},
					() => {
						see("dpkg in the original process");
						// postinst restarts ceralive.service: this process never reads again.
						connected = false;
						restarted.resolve();
						return new Promise<never>(() => {});
					},
				],
			});
			spyOn(transaction, "runDetachedAptAll").mockImplementation(
				(args, verdict, handlers) => realRun(args, verdict, handlers, depsA),
			);
			seen.accepted = structuredClone(h.frames.at(-1)?.updating);
			void run().catch(restarted.reject);
			await restarted.promise;

			// The restarted backend process; the same unit is still running.
			updates.resetSoftwareUpdateState();
			updates.beginSoftwareUpdateRecovery();
			files.status += pm("60.0000");
			connected = true;
			apply(buildInitialStatus().status);
			see("re-authenticated before recovery");
			let stateB: "running" | "finished" = "running";
			let completion: Promise<number> | undefined;
			const depsB = unitDeps(files, {
				state: () => stateB,
				exitCode,
				failFirstStdoutRead: true,
				steps: [
					() => {
						see("attached, first read failed");
						seen["a new tab is still told nothing"] = !(
							"updating" in buildInitialStatus().status
						);
					},
					() => {
						see("caught up");
						files.status +=
							"pmstatus:man-db:55.0000:Processing triggers for man-db\n";
					},
					() => {
						see("estimate dips");
						files.status += pm("80.0000");
					},
					() => {
						see("later progress");
						stateB = "finished";
						unitFinished = true;
					},
				],
			});
			await updates.recoverSoftwareUpdateIfRunning({
				recover: async (handlers) => {
					const recovered = await realRecover(handlers, depsB);
					completion = recovered?.completion;
					return recovered;
				},
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			});
			expect(await completion).toBe(exitCode);
			await h.settled();
			see("outcome");
			seen["outcome state"] = h.frames.at(-1)?.update_state?.kind;

			// The process after the outcome finds no unit.
			updates.resetSoftwareUpdateState();
			updates.beginSoftwareUpdateRecovery();
			apply(buildInitialStatus().status);
			see("re-authenticated after the outcome");
			await updates.recoverSoftwareUpdateIfRunning({
				recover: async () => null,
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			});
			see("no unit");

			const outcome = seen.outcome as UpdateProgress;
			expect(seen).toEqual({
				accepted: { total: 0, downloading: 0, unpacking: 0, setting_up: 0 },
				"pinned download in flight": downloading,
				"unit cache hit": downloading,
				"dpkg in the original process": installingAt(40),
				"re-authenticated before recovery": installingAt(40),
				"attached, first read failed": installingAt(40),
				"a new tab is still told nothing": true,
				"caught up": installingAt(60),
				"estimate dips": installingAt(60),
				"later progress": installingAt(80),
				outcome,
				"outcome state": terminal,
				"re-authenticated after the outcome": outcome,
				"no unit": null,
			});
			expect(
				terminal === "success"
					? outcome.result === 0
					: typeof outcome.result === "string",
			).toBe(true);
			for (let i = 1; i < applied.length; i++)
				expect(rank(applied[i] as UpdateProgress)).toBeGreaterThanOrEqual(
					rank(applied[i - 1] as UpdateProgress),
				);
			expect(applied.some((u) => (u.percent ?? 0) >= 100)).toBe(false);
		});
	},
);

test("a pinned prefetch keeps the download phase when the unit starts", async () => {
	await withDeviceType("real", async () => {
		const { h, run } = await install([sample("eth0", "ethernet", 6)]);
		await using _h = h;
		const files: Files = { stdout: "", stderr: "", status: "" };
		let state: "absent" | "running" | "finished" = "absent";
		let firstDrain: unknown;
		const deps = unitDeps(files, {
			state: () => state,
			exitCode: 0,
			onStart: () => {
				state = "running";
				files.stdout = "Reading package lists...\n";
			},
			steps: [
				() => {
					firstDrain = structuredClone(h.frames.at(-1)?.updating);
					state = "finished";
				},
			],
		});
		spyOn(transaction, "runDetachedAptAll").mockImplementation(
			(args, verdict, handlers) => realRun(args, verdict, handlers, deps),
		);
		await run();
		await h.settled();
		expect(firstDrain).toEqual(downloading);
	});
});
