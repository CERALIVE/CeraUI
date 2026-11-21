import { describe, expect, test } from "bun:test";
import type { StatusResponse, UpdateProgress } from "@ceraui/rpc";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { deriveUpdateProgress } from "../modules/system/apt-progress.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
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

// Byte-exact APT::Status-Fd records as APT 3.0 writes them, one line per write
// (apt-pkg/acquire.cc pkgAcquireStatus::Pulse, apt-pkg/install-progress.cc).
const dl = (percent: string) =>
	`dlstatus:1:${percent}:Retrieving file 1 of 1\n`;
const pm = (pkg: string, percent: string, action: string) =>
	`pmstatus:${pkg}:${percent}:${action}\n`;

const fetchStatus = dl("0.0000") + dl("41.2500");
const dpkgStatus =
	fetchStatus +
	pm("dpkg-exec", "0.0000", "Running dpkg") +
	pm("cerastream", "20.0000", "Preparing cerastream") +
	pm("cerastream", "40.0000", "Unpacking cerastream");
const pmerror =
	"pmerror:cerastream:arm64:40.0000:installed cerastream package post-installation script subprocess returned error exit status 1\n";
const fetchLog =
	"Reading package lists...\nThe following packages will be upgraded:\n  cerastream\n" +
	"1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n" +
	"Get:1 https://apt.invalid trixie/main arm64 cerastream arm64 2 [48 MB]\n";
const dpkgLog =
	`${fetchLog}(Reading database ... 1234 files and directories currently installed.)\n` +
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
	test("reports APT's own percentage for the phase it is in", () => {
		expect(deriveUpdateProgress("", "")).toEqual(preparing);
		expect(deriveUpdateProgress(fetchLog, fetchStatus)).toEqual(
			downloadingAt(41),
		);
		expect(deriveUpdateProgress(dpkgLog, dpkgStatus)).toEqual(installingAt(40));
	});

	test("a record earns nothing until its line is complete, at every byte split", () => {
		const status = dpkgStatus + pm("cerastream", "80.0000", "Installed x");
		for (let end = 0; end <= status.length; end++) {
			const prefix = status.slice(0, end);
			expect(deriveUpdateProgress("", prefix)).toEqual(
				deriveUpdateProgress("", completeLines(prefix)),
			);
		}
	});

	test("never reports completion while the transaction is running", () => {
		expect(deriveUpdateProgress("", dl("100.0000"))).toEqual(downloadingAt(99));
		expect(
			deriveUpdateProgress("", pm("cerastream", "99.9900", "Installed x")),
		).toEqual(installingAt(99));
	});

	test("a package error freezes the percentage APT reported before it", () => {
		const status =
			dpkgStatus + pmerror + pm("libother", "60.0000", "Installed libother");
		expect(deriveUpdateProgress(dpkgLog, status)).toEqual(installingAt(40));
	});

	test("a later download record cannot move an install back to downloading", () => {
		expect(deriveUpdateProgress("", dpkgStatus + dl("12.0000"))).toEqual(
			installingAt(40),
		);
	});

	test("ignores lines that are not well-formed status records", () => {
		const noise =
			"pmstatus:cerastream:nan:Unpacking\npmstatus:cerastream:150.0000:x\n" +
			"dlstatus:1:-1:x\nmedia-change:x\nstatus: cerastream: unpacked\n" +
			"E: Sub-process /usr/bin/dpkg returned an error code (1)\n";
		expect(deriveUpdateProgress("", fetchStatus + noise)).toEqual(
			downloadingAt(41),
		);
	});

	test("without a status channel the transcript gives a phase and never a number", () => {
		expect(deriveUpdateProgress(fetchLog, "")).toEqual(downloadingAt());
		expect(deriveUpdateProgress(dpkgLog, "")).toEqual(installingAt());
		// A PTY can append a record to an unterminated script line.
		expect(
			deriveUpdateProgress(
				`${fetchLog}postinst outputSetting up cerastream (2) ...\n`,
				"",
			),
		).toEqual(installingAt());
	});

	test("a percentage from another phase is never shown", () => {
		expect(deriveUpdateProgress(dpkgLog, fetchStatus)).toEqual(installingAt());
	});
});

type Files = {
	readonly stdout: string;
	readonly stderr?: string;
	readonly status?: string;
};
type Mode = "live" | "reattached" | "finished replay";

async function observe(
	mode: Mode,
	checkpoints: readonly Files[],
	aptStatus = true,
) {
	await using h = await updateHarness();
	const paths = softwareUpdateOutputPaths();
	const points =
		mode === "finished replay" ? checkpoints.slice(-1) : checkpoints;
	const reads = { stdout: 0, stderr: 0, status: 0 };
	const end = { stdout: 0, stderr: 0, status: 0 };
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
					? {
							kind: "finished",
							exitCode: 100,
							cleanup: "reset-failed",
							...(aptStatus ? { aptStatus: true } : {}),
						}
					: { kind: "running", ...(aptStatus ? { aptStatus: true } : {}) },
		start: async () => {
			started = true;
		},
		prepareOutput: async () => {},
		readOutput: async (path, offset) => {
			const file =
				path === paths.stdout
					? "stdout"
					: path === paths.stderr
						? "stderr"
						: path === paths.status
							? "status"
							: undefined;
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
					settled = recovered?.completion;
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
	"APT status progress (%s)",
	(mode) => {
		test("publishes the same final frame for the same bytes", async () => {
			const { running, states } = await observe(mode, [
				{ stdout: fetchLog, status: fetchStatus },
				{ stdout: dpkgLog, status: dpkgStatus },
			]);
			expect(running).toEqual(
				mode === "live"
					? [preparing, downloadingAt(41), installingAt(40)]
					: mode === "reattached"
						? [downloadingAt(41), installingAt(40)]
						: [installingAt(40)],
			);
			expect(
				states.filter((state) => state.kind === "installing").at(-1),
			).toEqual({ kind: "installing", progress: installingAt(40) });
			expect(states.at(-1)?.kind).toBe("failed");
		});

		test("a failed package never earns more progress or completion", async () => {
			const { running, states } = await observe(mode, [
				{ stdout: dpkgLog, status: dpkgStatus },
				{
					stdout: `${dpkgLog}dpkg: error processing package cerastream (--configure):\n`,
					stderr: "E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
					status: `${dpkgStatus}${pmerror}${pm("libother", "60.0000", "Installed libother")}`,
				},
			]);
			expect(running.at(-1)).toEqual(installingAt(40));
			expect(running.every((frame) => (frame.percent ?? 0) <= 40)).toBe(true);
			const failure = states.at(-1);
			expect(failure?.kind).toBe("failed");
			// Status records live in their own file, so the reason is apt's error text.
			expect(failure?.kind === "failed" ? failure.reason : "").toBe(
				"E: Sub-process /usr/bin/dpkg returned an error code (1)",
			);
		});

		test("reads output larger than one bounded read to the end", async () => {
			const filler = "  postinst: rebuilding caches\n".repeat(4_000);
			const status =
				dl("1.0000").repeat(3_000) +
				pm("dpkg-exec", "0.0000", "Running dpkg") +
				pm("cerastream", "40.0000", "Unpacking cerastream");
			const stdout = `${dpkgLog}${filler}`;
			expect(Buffer.byteLength(stdout)).toBeGreaterThan(
				SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
			);
			expect(Buffer.byteLength(status)).toBeGreaterThan(
				SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
			);
			const { running, end } = await observe(mode, [{ stdout, status }]);
			expect(running.at(-1)).toEqual(installingAt(40));
			expect(end).toEqual({
				stdout: Buffer.byteLength(stdout),
				stderr: 0,
				status: Buffer.byteLength(status),
			});
		});
	},
);

describe("reattachment", () => {
	test("announces a recovered unit once, from what its files already prove", async () => {
		const { running } = await observe("reattached", [
			{ stdout: "", status: "" },
			{ stdout: dpkgLog, status: dpkgStatus },
		]);
		expect(running).toEqual([preparing, installingAt(40)]);
	});

	test("a unit started before the status channel is never read for it and shows phases only", async () => {
		const stale = pm("cerastream", "80.0000", "Installed cerastream");
		const { running, reads } = await observe(
			"reattached",
			[
				{ stdout: fetchLog, status: stale },
				{ stdout: dpkgLog, status: stale },
			],
			false,
		);
		expect(reads.status).toBe(0);
		expect(running).toEqual([downloadingAt(), installingAt()]);
	});

	test("finished replay of a pre-channel unit reads its whole transcript", async () => {
		const stdout = `${fetchLog}${"Fetched 48 MB in 7s (6,857 kB/s)\n".repeat(3_000)}Unpacking cerastream (2) over (1) ...\n`;
		expect(Buffer.byteLength(stdout)).toBeGreaterThan(
			SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
		);
		const { running, end } = await observe(
			"finished replay",
			[{ stdout }],
			false,
		);
		expect(running).toEqual([installingAt()]);
		expect(end.stdout).toBe(Buffer.byteLength(stdout));
	});
});

test("every read split of the status file converges without a partial number", async () => {
	const allowed = [
		preparing,
		downloadingAt(),
		downloadingAt(0),
		downloadingAt(41),
		installingAt(0),
		installingAt(20),
		installingAt(40),
	];
	for (let split = 1; split < dpkgStatus.length; split += 7) {
		const { running } = await observe("live", [
			// apt writes each status record before the dpkg output it announces.
			{ stdout: fetchLog, status: dpkgStatus.slice(0, split) },
			{ stdout: dpkgLog, status: dpkgStatus },
		]);
		for (const frame of running) expect(allowed).toContainEqual(frame);
		expect(running.at(-1)).toEqual(installingAt(40));
	}
});

test("APT's percentage never moves backward within a phase", () => {
	expect(deriveUpdateProgress("", dl("41.0000") + dl("30.0000"))).toEqual(
		downloadingAt(41),
	);
	const status = `${dpkgStatus}${pm("cerastream", "35.0000", "Processing triggers")}`;
	expect(deriveUpdateProgress("", status)).toEqual(installingAt(40));
});

test("a pinned prefetch keeps the download phase when the unit starts", async () => {
	await using h = await updateHarness();
	expect(startSoftwareUpdate()).toEqual({ started: true });
	const monitor = createSoftwareUpdateProcessMonitor(fetchLog);
	monitor.handlers.onDrained?.();
	expect(h.frames.at(-1)?.updating).toEqual(downloadingAt());
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

	test("hears an explicit null once recovery finds no unit", async () => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		await recover(() => {}, false);
		expect(h.frames.at(-1)?.updating).toBeNull();
		expect(buildInitialStatus().status.updating).toBeNull();
	});
});
