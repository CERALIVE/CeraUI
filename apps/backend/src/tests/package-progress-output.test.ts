import { describe, expect, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc/schemas";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import {
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	createSoftwareUpdateProcessMonitor,
	recoverSoftwareUpdateIfRunning,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const pin = { name: "libmm-glib0", version: "2" };
const boundary = "Download complete and in download only mode\n";
const plan =
	`${boundary}The following packages will be upgraded:\n  libmm-glib0\n` +
	"1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
const pair =
	`${boundary}The following packages will be upgraded:\n  libmm-glib0 cera-widget\n` +
	"2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n" +
	"Unpacking libmm-glib0 (2) over (1) ...\n" +
	"Unpacking cera-widget (2) over (1) ...\n" +
	"Setting up libmm-glib0 (2) ...\n";
const laterSetup = "Setting up cera-widget (2) ...\n";
const failed = "dpkg: error processing package libmm-glib0 (--configure):\n";

type Checkpoint = readonly [stdout: string, stderr?: string];
type Mode = "live" | "replay";

async function observe(
	mode: Mode,
	checkpoints: readonly Checkpoint[],
	architecture: string | null = "arm64",
) {
	await using h = await updateHarness();
	let archReads = 0;
	const readNativeArchitecture = () => {
		archReads++;
		return Promise.resolve(architecture ?? undefined);
	};
	const paths = softwareUpdateOutputPaths();
	const points = mode === "replay" ? checkpoints.slice(-1) : checkpoints;
	let started = mode === "replay";
	let cursor = 0;
	let finished = mode === "replay";
	let settled: Promise<number> | undefined;
	const seen: (UpdateProgress | boolean | null | undefined)[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: paths,
		inspect: async () =>
			!started
				? { kind: "absent" }
				: finished
					? {
							kind: "finished",
							exitCode: 100,
							cleanup: "reset-failed",
							pinnedInstall: [pin.name],
						}
					: { kind: "running" },
		start: async () => {
			started = true;
		},
		prepareOutput: async () => {},
		readOutput: async (path, offset) => {
			const bytes = Buffer.from(
				points[cursor]?.[path === paths.stdout ? 0 : 1] ?? "",
			);
			return { bytes: bytes.subarray(offset), nextOffset: bytes.length };
		},
		sleep: async () => {
			seen.push(structuredClone(buildInitialStatus().status.updating));
			cursor++;
			finished = cursor === points.length - 1;
			if (cursor >= points.length) throw new Error("extra poll");
		},
		cleanup: async () => {},
	};
	if (mode === "live") {
		expect(startSoftwareUpdate()).toEqual({ started: true });
		const monitor = createSoftwareUpdateProcessMonitor(
			"",
			readNativeArchitecture,
		);
		await monitor.finish(
			runDetachedAptAll(
				buildAptAllInstallArgs([pin], "any"),
				"any",
				monitor.handlers,
				deps,
			),
		);
	} else {
		const recovery = {
			recover: async (
				handlers: Parameters<typeof recoverDetachedAptUpgrade>[0],
			) => {
				const recovered = await recoverDetachedAptUpgrade(handlers, deps);
				settled = recovered?.completion;
				return recovered;
			},
			readNativeArchitecture,
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		};
		expect(await recoverSoftwareUpdateIfRunning(recovery)).toBe(true);
		expect(await settled).toBe(100);
	}
	const installing = h.frames.flatMap((frame) =>
		frame.update_state?.kind === "installing"
			? [frame.update_state.progress]
			: [],
	);
	expect(buildInitialStatus().status.update_state?.kind).toBe("failed");
	expect(archReads).toBe(1);
	return { installing, seen };
}

describe.each(["live", "replay"] as const)(
	"package progress from %s output",
	(mode) => {
		test("matches a bare native plan to dpkg's qualified native records", async () => {
			const unpack = `${plan}Unpacking libmm-glib0:arm64 (2) over (1) ...\n`;
			const { installing } = await observe(mode, [
				[unpack],
				[`${unpack}Setting up libmm-glib0:arm64 (2) ...\n`],
			]);
			expect(installing.at(-1)).toEqual({
				total: 1,
				downloading: 1,
				unpacking: 1,
				setting_up: 1,
			});
		});

		test("a foreign identity cannot consume a bare native plan slot", async () => {
			const unpack = `${plan}Unpacking libmm-glib0:amd64 (2) over (1) ...\n`;
			const { installing } = await observe(mode, [
				[unpack],
				[`${unpack}Setting up libmm-glib0:amd64 (2) ...\n`],
			]);
			expect(installing.at(-1)).toMatchObject({ total: 0, setting_up: 1 });
			expect(installing.every((frame) => frame.total === 0)).toBe(true);
		});

		test("does not guess the native identity when the architecture probe is unavailable", async () => {
			const unpack = `${plan}Unpacking libmm-glib0:arm64 (2) over (1) ...\n`;
			const { installing } = await observe(
				mode,
				[[unpack], [`${unpack}Setting up libmm-glib0:arm64 (2) ...\n`]],
				null,
			);
			expect(installing.at(-1)).toEqual({
				total: 0,
				downloading: 0,
				unpacking: 1,
				setting_up: 1,
			});
		});

		test("configure-only output without a plan still reports installation activity", async () => {
			const { installing } = await observe(mode, [
				[boundary],
				[`${boundary}Setting up configure-only (2) ...\n`],
			]);
			expect(installing.at(-1)).toEqual({
				total: 0,
				downloading: 0,
				unpacking: 0,
				setting_up: 1,
			});
		});

		test.each([
			failed,
			"dpkg: dependency problems prevent configuration of libmm-glib0:\n",
			"E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
		])(
			"holds at four completed steps when B starts after %s",
			async (marker) => {
				const { installing } = await observe(mode, [
					[pair],
					[`${pair}${marker.slice(0, 14)}`],
					[`${pair}${marker}${laterSetup}`],
				]);
				expect(installing.at(-1)).toEqual({
					total: 2,
					downloading: 2,
					unpacking: 2,
					setting_up: 1,
				});
				expect(installing.some((frame) => frame.setting_up === 2)).toBe(false);
			},
		);

		test.each([
			["postinst output", failed],
			[
				"postinst output\r",
				"dpkg: dependency problems prevent configuration of libmm-glib0:\r\n",
			],
			[
				"postinst output\r",
				"E: Sub-process /usr/bin/dpkg returned an error code (1)\r\n",
			],
		])(
			"freezes when PTY output precedes the error without a newline: %s %s",
			async (prefix, marker) => {
				const partial = `${pair}${prefix}${marker.slice(0, 14)}`;
				const error = `${pair}${prefix}${marker}`;
				const { installing, seen } = await observe(mode, [
					[pair],
					[partial],
					[error],
					[`${error}${laterSetup}`],
				]);
				const fourSteps = {
					total: 2,
					downloading: 2,
					unpacking: 2,
					setting_up: 1,
				};
				expect(installing).toEqual([fourSteps]);
				if (mode === "live")
					expect(seen).toEqual([fourSteps, fourSteps, fourSteps]);
			},
		);

		test("holds a count while a mid-line stderr marker is still partial", async () => {
			const prefix = "postinst output\r";
			const { installing, seen } = await observe(mode, [
				[pair],
				[`${pair}${laterSetup}`, prefix + failed.slice(0, 14)],
				[`${pair}${laterSetup}`, prefix + failed],
			]);
			const fourSteps = {
				total: 2,
				downloading: 2,
				unpacking: 2,
				setting_up: 1,
			};
			if (mode === "live") {
				expect(installing).toEqual([fourSteps]);
				expect(seen).toEqual([fourSteps, fourSteps]);
			} else {
				expect(installing).toEqual([
					{ total: 0, downloading: 0, unpacking: 1, setting_up: 1 },
				]);
			}
		});

		test("never credits the next package from the same read as a separate stderr failure", async () => {
			const { installing, seen } = await observe(mode, [
				[pair],
				[`${pair}${laterSetup}`, failed.slice(0, 14)],
				[`${pair}${laterSetup}`, failed],
			]);
			if (mode === "live") {
				const fourSteps = {
					total: 2,
					downloading: 2,
					unpacking: 2,
					setting_up: 1,
				};
				expect(seen).toEqual([fourSteps, fourSteps]);
				expect(installing.at(-1)).toEqual(fourSteps);
			} else {
				// Separate retained files have no shared ordering on a cold read.
				expect(installing.at(-1)).toEqual({
					total: 0,
					downloading: 0,
					unpacking: 1,
					setting_up: 1,
				});
			}
			expect(installing.some((frame) => frame.setting_up === 2)).toBe(false);
		});
	},
);
