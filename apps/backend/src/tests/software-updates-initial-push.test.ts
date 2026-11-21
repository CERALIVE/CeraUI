import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusResponseSchema } from "@ceraui/rpc";

import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import {
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import { expectedAptAllScript } from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";
import {
	createSoftwareUpdateProcessMonitor,
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { addClient, getClients, removeClient } from "../rpc/events.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const update = {
	total: 0,
	downloading: 0,
	unpacking: 0,
	setting_up: 0,
};

function socket(received: unknown[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send(message: string) {
			received.push(JSON.parse(message));
		},
	} as AppWebSocket;
}

describe("software-update status reaches clients across recovery", () => {
	afterEach(() => {
		for (const client of [...getClients()]) removeClient(client);
		resetSoftwareUpdateState();
	});

	test("a freshly authenticated client receives both fields in the initial status", async () => {
		const recovered = await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return undefined as never;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		expect(recovered).toBe(false);

		const status = buildInitialStatus().status;
		expect(status).toHaveProperty("updating");
		expect(status).toHaveProperty("update_state");
		expect(status.updating).not.toBeNull();
	});

	test("a client already authenticated receives the reattach broadcast", async () => {
		const received: unknown[] = [];
		const client = socket(received);
		addClient(client);

		await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return undefined as never;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});

		const frame = received.find((value) => {
			const status = (value as { status?: Record<string, unknown> }).status;
			return status?.updating !== undefined;
		}) as { status: { updating: unknown; update_state: unknown } };
		expect(frame.status).toHaveProperty("updating");
		expect(frame.status).toHaveProperty("update_state");
		expect(frame.status.updating).toEqual(update);
	});

	test("a client after the terminal frame receives explicit updating null", () => {
		const status = buildInitialStatus().status;
		expect(status).toHaveProperty("updating", null);
		expect(status).toHaveProperty("update_state");
	});

	test("publishes a single buffered package's first install progress to both status consumers", async () => {
		const received: unknown[] = [];
		addClient(socket(received));

		await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached, onStdout }) => {
				onAttached?.();
				onStdout("Reading package lists...\n");
				expect(buildInitialStatus().status.updating).toEqual(update);

				// No parseable counters until apt releases the buffered transcript.
				onStdout(
					"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove.\n" +
						"Get:1 https://example.invalid cerastream [48 MB]\n" +
						"Unpacking cerastream (2) over (1) ...\n",
				);
				return null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});

		const installing = { ...update, total: 1, downloading: 1, unpacking: 1 };
		const frames = received.flatMap((frame) => {
			if (typeof frame !== "object" || !frame || !("status" in frame))
				return [];
			const parsed = statusResponseSchema.safeParse(frame.status);
			return parsed.success && parsed.data.updating ? [parsed.data] : [];
		});
		expect(frames).toMatchObject([
			{
				updating: update,
				update_state: { kind: "downloading", progress: update },
			},
			{
				updating: installing,
				update_state: { kind: "installing", progress: installing },
			},
		]);
	});
});

const pinnedArgs = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);

function inspectPinnedUpdate(finished: boolean) {
	const stdout = [
		"Id=ceralive-software-update.service",
		"FragmentPath=/run/systemd/transient/ceralive-software-update.service",
		"Description=CeraLive software update",
		"LoadState=loaded",
		`ActiveState=${finished ? "failed" : "active"}`,
		`SubState=${finished ? "failed" : "running"}`,
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		"User=",
		"ExecStartPre=",
		"ExecStartPost=",
		"StandardOutput=append",
		"StandardError=append",
		`ExecMainCode=${finished ? 1 : 0}`,
		`ExecMainStatus=${finished ? 100 : 0}`,
		`ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec ${expectedAptAllScript(pinnedArgs, [])} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=42 ; code=exited ; status=100 }`,
	].join("\n");
	return parseDetachedAptServiceProbe({ stdout, stderr: "", exitCode: 0 }, [
		"systemctl",
		"show",
	]);
}

describe.each(["live", "reattached"] as const)(
	"pinned install progress (%s)",
	(mode) => {
		test.each([
			["two download candidates, one installed", 2, true, true, false],
			["one download candidate, one installed", 1, true, true, false],
			["missing install summary", 2, true, false, false],
			["missing phase boundary", 2, false, true, false],
			["solver-added dependency", 2, true, true, true],
		] as const)(
			"uses only a proven install denominator: %s",
			async (_name, downloadCount, boundary, installSummary, dependency) => {
				await using _h = await updateHarness();
				const paths = softwareUpdateOutputPaths();
				const received: unknown[] = [];
				const client = socket(received);
				addClient(client);
				const dir = await mkdtemp(join(tmpdir(), "ceraui-pinned-progress-"));
				const file = join(dir, "stdout");
				const fetch = `The following packages will be upgraded:\n  cerastream${downloadCount === 2 ? " unrelated-upgrade" : ""}\n${downloadCount} upgraded, 0 newly installed, 0 to remove.\nGet:1 https://example.invalid cerastream [48 MB]\n`;
				const partial = `${boundary ? "Download complete and in download only mode\n" : ""}Reading package lists...\nThe following packages will be upgraded:\n  cerastream\n${dependency ? "The following NEW packages will be installed:\n  libnew-dependency:arm64\n" : ""}${installSummary ? `1 upgraded, ${Number(dependency)} newly installed, 0 to remove.\n` : ""}${dependency ? "Unpacking libnew-dependency:arm64 (1) ...\nSetting up libnew-dependency:arm64 (1) ...\n" : ""}Unpacking cerastream:arm64 (2) over (1) ...\n`;
				const unrelated = "Setting up pending-unrelated:arm64 (1) ...\n";
				const setup =
					"Setting up cerastream (2) ...\nSetting up cerastream:arm64 (2) ...\n";
				// Reattach to a running unit after the unrelated setup has already
				// reached disk. Both paths then watch cerastream's actual setup.
				const checkpoints =
					mode === "live"
						? [
								fetch,
								fetch + partial,
								fetch + partial + unrelated,
								fetch + partial + unrelated + setup,
							]
						: [
								fetch + partial + unrelated,
								fetch + partial + unrelated + setup,
							];
				let checkpoint = 0;
				let finished = false;
				let started = mode === "reattached";
				const installTotal =
					boundary && installSummary ? (dependency ? 2 : 1) : 0;
				const beforeWrites: unknown[] = [];
				let replayCompletion: Promise<number> | undefined;
				const deps = {
					outputPaths: paths,
					inspect: async () =>
						started
							? inspectPinnedUpdate(finished)
							: { kind: "absent" as const },
					start: async () => {
						started = true;
					},
					prepareOutput: async () => {},
					readOutput: async (path: string, offset: number) => {
						const bytes =
							path === paths.stdout ? await readFile(file) : Buffer.alloc(0);
						return { bytes: bytes.subarray(offset), nextOffset: bytes.length };
					},
					sleep: async () => {
						if (finished) throw new Error("unexpected second poll");
						beforeWrites.push(buildInitialStatus().status.updating);
						const next = checkpoints[++checkpoint];
						if (next === undefined)
							throw new Error("unexpected output checkpoint");
						await writeFile(file, next);
						finished = checkpoint === checkpoints.length - 1;
					},
					cleanup: async () => {},
				};
				try {
					await writeFile(file, checkpoints[0] ?? "");
					if (mode === "live") {
						expect(startSoftwareUpdate()).toEqual({ started: true });
						expect(
							await runDetachedAptAll(
								pinnedArgs,
								"any",
								createSoftwareUpdateProcessMonitor().handlers,
								deps,
							),
						).toBe(100);
					} else {
						expect(
							await recoverSoftwareUpdateIfRunning({
								recover: async (handlers) => {
									const recovered = await recoverDetachedAptUpgrade(
										handlers,
										deps,
									);
									replayCompletion = recovered?.completion;
									return recovered;
								},
								scheduleRetry: () => {},
								resumePeriodicChecks: () => {},
							}),
						).toBe(true);
						expect(await replayCompletion).toBe(100);
					}

					const frames = received.flatMap((frame) => {
						if (typeof frame !== "object" || !frame || !("status" in frame))
							return [];
						const parsed = statusResponseSchema.safeParse(frame.status);
						return parsed.success ? [parsed.data] : [];
					});
					const progress = {
						total: installTotal,
						downloading: installTotal,
						unpacking: installTotal,
						setting_up: installTotal,
					};
					const firstProgress = {
						...progress,
						setting_up: Math.max(0, installTotal - 1),
					};
					const installFrames = frames.filter(
						(frame) => frame.update_state?.kind === "installing",
					);
					if (installTotal > 0) {
						expect(beforeWrites.at(-1)).toEqual(firstProgress);
						expect(installFrames).toEqual([
							{
								updating: firstProgress,
								update_state: { kind: "installing", progress: firstProgress },
							},
							{
								updating: progress,
								update_state: { kind: "installing", progress },
							},
						]);
					} else {
						const unknownTotal = { ...update, unpacking: 1 };
						const configured = { ...unknownTotal, setting_up: 1 };
						expect(installFrames).toEqual([
							{
								updating: unknownTotal,
								update_state: { kind: "installing", progress: unknownTotal },
							},
							{
								updating: configured,
								update_state: { kind: "installing", progress: configured },
							},
						]);
					}
					expect(frames[0]).toEqual({
						updating: update,
						update_state: { kind: "downloading", progress: update },
					});
					for (const frame of frames)
						if (frame.update_state?.kind === "downloading")
							expect(frame.update_state.progress.total).toBe(0);
				} finally {
					removeClient(client);
					await rm(dir, { recursive: true, force: true });
				}
			},
		);
	},
);
