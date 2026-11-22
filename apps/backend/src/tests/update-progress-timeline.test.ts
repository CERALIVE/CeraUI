import { expect, spyOn, test } from "bun:test";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import type { DetachedAptUpgradeDeps } from "../modules/system/software-update-process.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

const realRun = transaction.runDetachedAptAll;
const { t, install } = aptEntryHarness();
const paths = softwareUpdateOutputPaths();
const downloading = { total: 1, downloading: 1, unpacking: 0, setting_up: 0 };
type Files = { stdout: string; stderr: string };

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
			if (state === "running") return { kind: "running" };
			return {
				kind: "finished",
				exitCode: o.exitCode,
				cleanup: o.exitCode === 0 ? "stop" : "reset-failed",
			};
		},
		cleanup: async () => {},
		readOutput: async (path, offset) => {
			const file = path === paths.stdout ? "stdout" : "stderr";
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

test("a pinned prefetch keeps the download phase when the unit starts", async () => {
	await withDeviceType("real", async () => {
		const { h, run } = await install([sample("eth0", "ethernet", 6)]);
		await using _h = h;
		const files: Files = { stdout: "", stderr: "" };
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
