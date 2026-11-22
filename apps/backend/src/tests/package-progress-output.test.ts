import { describe, expect, test } from "bun:test";
import type { StatusResponse, UpdateProgress } from "@ceraui/rpc";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { deriveUpdateProgress } from "../modules/system/apt-progress.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	DetachedAptServiceVanishedError,
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	createSoftwareUpdateProcessMonitor,
	recoverSoftwareUpdateIfRunning,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

// APT's transcript as the unit's stdout file holds it (non-interactive
// apt-get: the plan, one "Get:" per archive as it starts, "Fetched" when all
// are in; dpkg's "Unpacking" and "Setting up" as each step starts).
const fetchLog =
	"Reading package lists...\nThe following packages will be upgraded:\n  cerastream\n" +
	"1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n" +
	"Get:1 https://apt.invalid trixie/main arm64 cerastream arm64 2 [48 MB]\n";
const fetched = `${fetchLog}Fetched 48 MB in 7s (6,857 kB/s)\n`;
const dpkgLog =
	`${fetched}(Reading database ... 1234 files and directories currently installed.)\n` +
	"Preparing to unpack .../cerastream_2_arm64.deb ...\n" +
	"Unpacking cerastream (2) over (1) ...\nSetting up cerastream (2) ...\n";

const preparing = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };
const downloadingAt = (percent?: number) => ({
	total: 1,
	downloading: 1,
	unpacking: 0,
	setting_up: 0,
	...(percent === undefined ? {} : { percent }),
});
const installingAt = (percent?: number) => ({
	total: 1,
	downloading: 0,
	unpacking: 0,
	setting_up: 1,
	...(percent === undefined ? {} : { percent }),
});

const completeLines = (text: string) =>
	text.slice(0, text.lastIndexOf("\n") + 1);

describe("deriveUpdateProgress()", () => {
	test("the transcript's own counts give the number for the phase it is in", () => {
		expect(deriveUpdateProgress("")).toEqual(preparing);
		// The only archive has started, none is in yet: no number.
		expect(deriveUpdateProgress(fetchLog)).toEqual(downloadingAt());
		expect(deriveUpdateProgress(fetched)).toEqual(downloadingAt(99));
		// Unpacking is done once Setting up started: one of two steps.
		expect(deriveUpdateProgress(dpkgLog)).toEqual(installingAt(50));
	});

	test("a line earns nothing until it is complete, at every byte split", () => {
		for (let end = 0; end <= dpkgLog.length; end++) {
			const prefix = dpkgLog.slice(0, end);
			expect(deriveUpdateProgress(prefix)).toEqual(
				deriveUpdateProgress(completeLines(prefix)),
			);
		}
	});

	test("never reports completion while the transaction is running", () => {
		// A dependency outside the plan adds steps; the number stops at 99.
		const extra =
			"Unpacking libextra (1) ...\nSetting up libextra (1) ...\nProcessing triggers for libc-bin (2.41) ...\n";
		expect(deriveUpdateProgress(dpkgLog + extra)).toEqual(installingAt(99));
	});

	test("reinstalled and downgraded packages in the plan count too", () => {
		// apt-get prints them between "newly installed" and "to remove".
		const plan =
			"1 upgraded, 0 newly installed, 1 reinstalled, 1 downgraded, 0 to remove and 0 not upgraded.\n";
		const steps =
			"Unpacking a (2) over (1) ...\nUnpacking b (1) over (1) ...\nUnpacking c (1) over (2) ...\nSetting up a (2) ...\n";
		// Three of the six steps are done once the fourth has started.
		expect(deriveUpdateProgress(plan + steps)).toEqual(installingAt(50));
	});

	test("a later fetch line cannot move an install back to downloading", () => {
		expect(
			deriveUpdateProgress(
				`${dpkgLog}Get:2 https://apt.invalid x arm64 y [1 kB]\n`,
			),
		).toEqual(installingAt(50));
	});

	test("ignores lines that are not APT's or dpkg's own", () => {
		const noise =
			"Get: 3 not a fetch\nGet:x y\nsetting up cerastream (2)\n" +
			"Unpacking (bad)\nE: Sub-process /usr/bin/dpkg returned an error code (1)\n";
		expect(deriveUpdateProgress(fetchLog + noise)).toEqual(downloadingAt());
	});

	test("only whole lines in APT's and dpkg's own shape count", () => {
		// A hook or script line that quotes dpkg is not package work.
		const plan =
			"2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
		expect(
			deriveUpdateProgress(
				`${plan}hook diagnostic: Unpacking dummy1 (0); Setting up dummy1 (0); Unpacking dummy2 (0); Setting up dummy2 (0)\n`,
			),
		).toEqual(preparing);
		expect(
			deriveUpdateProgress(
				`${fetched}postinst outputUnpacking cerastream (2) over (1) ...\n`,
			),
		).toEqual(downloadingAt(99));
	});

	test("a repeated line counts once", () => {
		const twice = `${dpkgLog}Setting up cerastream (2) ...\nUnpacking cerastream (2) over (1) ...\n`;
		expect(deriveUpdateProgress(twice)).toEqual(installingAt(50));
		expect(
			deriveUpdateProgress(
				fetchLog +
					fetchLog
						.split("\n")
						.filter((line) => line.startsWith("Get:"))
						.join("\n") +
					"\n",
			),
		).toEqual(downloadingAt());
	});
});

type Files = {
	readonly stdout: string;
	readonly stderr?: string;
};
type Mode = "live" | "reattached" | "finished replay";

async function observe(mode: Mode, checkpoints: readonly Files[]) {
	await using h = await updateHarness();
	const paths = softwareUpdateOutputPaths();
	const points =
		mode === "finished replay" ? checkpoints.slice(-1) : checkpoints;
	const reads = { stdout: 0, stderr: 0 };
	const end = { stdout: 0, stderr: 0 };
	let started = mode !== "live";
	let cursor = 0;
	let polls = 0;
	let finished = points.length === 1;
	let settled: Promise<number> | undefined;
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: paths,
		inspect: async () =>
			!started
				? { kind: "absent" }
				: finished
					? { kind: "finished", exitCode: 100, cleanup: "reset-failed" }
					: { kind: "running" },
		start: async () => {
			started = true;
		},
		readAttempt: () => null,
		updateAttempt: (change) => change(null),
		prepareOutput: async () => {},
		readOutput: async (path, offset) => {
			const file =
				path === paths.stdout
					? "stdout"
					: path === paths.stderr
						? "stderr"
						: undefined;
			// APT is given no telemetry file: nothing else is ever read.
			if (file === undefined) throw new Error(`unexpected read of ${path}`);
			reads[file]++;
			const bytes = Buffer.from(points[cursor]?.[file] ?? "");
			// The production reader returns at most one bounded block per read.
			const block = bytes.subarray(
				offset,
				offset + SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
			);
			end[file] = Math.max(end[file], offset + block.byteLength);
			return { bytes: block, nextOffset: offset + block.byteLength };
		},
		sleep: async () => {
			polls++;
			if (polls > 50) throw new Error("observer kept polling");
			cursor = Math.min(cursor + 1, points.length - 1);
			finished = cursor === points.length - 1;
		},
		cleanup: async () => {},
	};
	if (mode === "live") {
		expect(startSoftwareUpdate()).toEqual({ started: true });
		const monitor = createSoftwareUpdateProcessMonitor();
		await monitor.finish(
			runDetachedAptAll(
				buildAptAllInstallArgs([{ name: "cerastream", version: "2" }], "any"),
				"any",
				monitor.handlers,
				deps,
			),
		);
	} else {
		expect(
			await recoverSoftwareUpdateIfRunning({
				recover: async (handlers) => {
					const recovered = await recoverDetachedAptUpgrade(handlers, deps);
					settled =
						recovered && "completion" in recovered
							? recovered.completion
							: undefined;
					return recovered;
				},
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			}),
		).toBe(true);
		expect(await settled).toBe(100);
	}
	await h.settled();
	const running: UpdateProgress[] = [];
	const states: NonNullable<StatusResponse["update_state"]>[] = [];
	for (const frame of h.frames) {
		const updating = frame.updating;
		if (
			typeof updating === "object" &&
			updating &&
			updating.result === undefined
		)
			running.push(updating);
		if (frame.update_state) states.push(frame.update_state);
	}
	const last = points.at(-1);
	return { running, states, reads, end, last };
}

describe.each(["live", "reattached", "finished replay"] as const)(
	"transcript progress (%s)",
	(mode) => {
		test("publishes the same final frame for the same bytes", async () => {
			const { running, states } = await observe(mode, [
				{ stdout: fetchLog },
				{ stdout: dpkgLog },
			]);
			expect(running).toEqual(
				mode === "live"
					? [preparing, downloadingAt(), installingAt(50)]
					: mode === "reattached"
						? [downloadingAt(), installingAt(50)]
						: [installingAt(50)],
			);
			expect(
				states.filter((state) => state.kind === "installing").at(-1),
			).toEqual({ kind: "installing", progress: installingAt(50) });
			expect(states.at(-1)?.kind).toBe("failed");
		});

		test("a failed package never earns completion; its exit decides", async () => {
			const { running, states } = await observe(mode, [
				{ stdout: dpkgLog },
				{
					stdout: `${dpkgLog}dpkg: error processing package cerastream (--configure):\n`,
					stderr: "E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
				},
			]);
			expect(running.at(-1)).toEqual(installingAt(50));
			expect(running.every((frame) => (frame.percent ?? 0) <= 50)).toBe(true);
			const failure = states.at(-1);
			expect(failure?.kind).toBe("failed");
			expect(failure?.kind === "failed" ? failure.reason : "").toBe(
				"E: Sub-process /usr/bin/dpkg returned an error code (1)",
			);
		});

		test("reads output larger than one bounded read to the end", async () => {
			const filler = "  postinst: rebuilding caches\n".repeat(4_000);
			const stdout = `${dpkgLog}${filler}`;
			expect(Buffer.byteLength(stdout)).toBeGreaterThan(
				SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
			);
			const { running, end } = await observe(mode, [{ stdout }]);
			expect(running.at(-1)).toEqual(installingAt(50));
			expect(end).toEqual({ stdout: Buffer.byteLength(stdout), stderr: 0 });
		});
	},
);

describe("reattachment", () => {
	test("announces a recovered unit once, from what its files already prove", async () => {
		const { running } = await observe("reattached", [
			{ stdout: "" },
			{ stdout: dpkgLog },
		]);
		expect(running).toEqual([preparing, installingAt(50)]);
	});

	test("finished replay reads a unit's whole transcript", async () => {
		const stdout = `${fetchLog}${"Fetched 48 MB in 7s (6,857 kB/s)\n".repeat(3_000)}Unpacking cerastream (2) over (1) ...\n`;
		expect(Buffer.byteLength(stdout)).toBeGreaterThan(
			SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
		);
		const { running, end } = await observe("finished replay", [{ stdout }]);
		expect(running).toEqual([installingAt()]);
		expect(end.stdout).toBe(Buffer.byteLength(stdout));
	});
});

test("every read split of the transcript converges without a partial count", async () => {
	const allowed = [
		preparing,
		downloadingAt(),
		downloadingAt(99),
		installingAt(),
		installingAt(50),
	];
	for (let split = 1; split < dpkgLog.length; split += 7) {
		const { running } = await observe("live", [
			{ stdout: dpkgLog.slice(0, split) },
			{ stdout: dpkgLog },
		]);
		for (const frame of running) expect(allowed).toContainEqual(frame);
		expect(running.at(-1)).toEqual(installingAt(50));
	}
});

test("the counted number never moves backward within a phase", () => {
	expect(
		deriveUpdateProgress(
			`${dpkgLog}Processing triggers for man-db (2.13) ...\n`,
		),
	).toEqual(installingAt(50));
});

describe("a reconnecting tab during recovery", () => {
	const recover = (
		attach: (handlers: Parameters<typeof recoverDetachedAptUpgrade>[0]) => void,
		found: boolean,
	) =>
		recoverSoftwareUpdateIfRunning({
			recover: async (handlers) => {
				attach(handlers);
				return found
					? {
							completion: new Promise<number>(() => {}),
							wasAlreadyFinished: false,
						}
					: null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});

	test("is not told nothing is updating before the unit's output was read", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		expect(buildInitialStatus().status).not.toHaveProperty("updating");
		let drained: (() => void) | undefined;
		await recover((handlers) => {
			handlers.onAttached?.();
			drained = handlers.onDrained;
		}, true);
		// Attached but unread: still no claim either way, and no empty frame.
		expect(buildInitialStatus().status).not.toHaveProperty("updating");
		expect(h.frames.some((frame) => frame.updating !== undefined)).toBe(false);
		drained?.();
		expect(buildInitialStatus().status.updating).toEqual(preparing);
		expect(h.frames.at(-1)?.updating).toEqual(preparing);
	});

	test("is told the outcome when the reattached unit settles before any read", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		await recoverSoftwareUpdateIfRunning({
			recover: async (handlers) => {
				handlers.onAttached?.();
				return {
					completion: Promise.reject(new Error("output unreadable")),
					wasAlreadyFinished: true,
				};
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		await h.settled();
		expect(buildInitialStatus().status.update_state?.kind).toBe("failed");
		expect(buildInitialStatus().status).toHaveProperty("updating", null);
	});

	test("an observer that loses the unit tells no outcome: not a failure, outcome not confirmed", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		await recoverSoftwareUpdateIfRunning({
			recover: async (handlers) => {
				handlers.onAttached?.();
				handlers.onStdout(dpkgLog);
				handlers.onDrained?.(true, false);
				return {
					completion: Promise.reject(new DetachedAptServiceVanishedError()),
					wasAlreadyFinished: true,
				};
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		// An already finished unit is settled before recovery returns.
		const status = buildInitialStatus().status;
		expect(status).toHaveProperty("updating", null);
		// The last frame about the install says it ended; the state broadcast follows it.
		expect(
			h.frames.findLast((frame) => "updating" in frame)?.updating,
		).toBeNull();
		expect(status.update_state?.kind).not.toBe("failed");
		expect(status.update_state?.kind).not.toBe("success");
		expect(
			h.frames.some((frame) => frame.update_state?.kind === "failed"),
		).toBe(false);
		expect(h.restarts).toBe(0);
	});

	test("a transcript that cannot be read shows the phase without a number until it can", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		let handlers: Parameters<typeof recoverDetachedAptUpgrade>[0] | undefined;
		await recover((attached) => {
			attached.onAttached?.();
			handlers = attached;
		}, true);
		handlers?.onStdout(dpkgLog);
		handlers?.onDrained?.(true, false);
		expect(h.frames.at(-1)?.updating).toEqual(installingAt(50));
		for (let poll = 0; poll < 4; poll++) handlers?.onDrained?.(false, true);
		// Unknown now: never the last number as if it were live.
		expect(h.frames.at(-1)?.updating).toEqual(installingAt());
		expect(buildInitialStatus().status.updating).toEqual(installingAt());
		handlers?.onDrained?.(true, false);
		expect(h.frames.at(-1)?.updating).toEqual(installingAt(50));
	});

	test("hears an explicit null once recovery finds no unit", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		await recover(() => {}, false);
		expect(h.frames.at(-1)?.updating).toBeNull();
		expect(buildInitialStatus().status.updating).toBeNull();
	});
});
