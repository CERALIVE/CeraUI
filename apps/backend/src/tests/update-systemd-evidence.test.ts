import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCommitStageRunning } from "../modules/system/update-orchestrator/commit-stage-probe.ts";
import { recoverCrossSlot } from "../modules/system/update-orchestrator/recovery.ts";
import { createRecoveryProbes } from "../modules/system/update-orchestrator/recovery-probes.ts";
import { sha256 } from "../modules/system/update-orchestrator/recovery-store.ts";
import {
	admitAndPrepareStreamStart,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";
import { createRecoveryFixture } from "./update-cross-slot-fixture.ts";

afterEach(resetOrchestratorRuntimeForTest);

const running =
	"LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/commit\n";
const contradictions: string[] = [
	"LoadState=not-found",
	"ActiveState=inactive",
	"ControlGroup=/empty",
	"malformed-row",
];

test.each(contradictions)(
	"D8 refuses contradictory package properties (%s) without stop",
	async (extra) => {
		// Given a cached download while a commit process actually exists.
		const dir = await mkdtemp(join(tmpdir(), "ceraui-systemd-evidence-"));
		await mkdir(join(dir, "commit"));
		await mkdir(join(dir, "empty"));
		await mkdir(join(dir, "123"));
		await writeFile(join(dir, "commit/cgroup.procs"), "123\n");
		await writeFile(join(dir, "empty/cgroup.procs"), "");
		await writeFile(join(dir, "123/comm"), "apt-get\n");
		await writeFile(
			join(dir, "123/cmdline"),
			"apt-get\0--no-download\0install\0",
		);
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () => ({
				kind: "downloading",
				progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 1 },
			}),
			isCommitStageRunning: () =>
				isCommitStageRunning({
					showUnit: async () => ({
						exitCode: 0,
						stdout: running + extra,
						stderr: "",
					}),
					cgroupRoot: dir,
					procRoot: dir,
				}),
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		try {
			// When real D8 admission consumes the real package probe.
			const result = await admitAndPrepareStreamStart();
			// Then contradictory evidence never grants stop authority.
			expect(result).toMatchObject({
				allowed: false,
				reason: "update_in_progress",
			});
			expect(calls.stop).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["idle", "running"] as const)(
	"D8 clean %s unit retains legitimate behavior",
	async (state) => {
		const dir = await mkdtemp(join(tmpdir(), "ceraui-clean-systemd-"));
		await mkdir(join(dir, "commit"));
		await mkdir(join(dir, "123"));
		await writeFile(join(dir, "commit/cgroup.procs"), "123\n");
		await writeFile(join(dir, "123/comm"), "dpkg\n");
		await writeFile(join(dir, "123/cmdline"), "dpkg\0--unpack\0");
		const { deps, calls } = abortSpyDeps({
			isCommitStageRunning: () =>
				isCommitStageRunning({
					showUnit: async () => ({
						exitCode: state === "idle" ? 1 : 0,
						stdout: state === "idle" ? "LoadState=not-found\n" : running,
						stderr: "",
					}),
					cgroupRoot: dir,
					procRoot: dir,
				}),
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		try {
			const result = await admitAndPrepareStreamStart();
			expect(result.allowed).toBe(state === "idle");
			expect(calls.stop).toBe(state === "idle" ? 1 : 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["LoadState", "ActiveState", "ControlGroup", "malformed"])(
	"maintenance rejects contradictory %s before recording or clearing",
	async (key) => {
		// Given a valid unresolved commit and conflicting absence properties.
		const fixture = await createRecoveryFixture();
		const output =
			"LoadState=not-found\nActiveState=inactive\nControlGroup=\n" +
			(key === "malformed" ? "invalid" : `${key}=not-found`);
		const probes = createRecoveryProbes({
			run: async () => ({ code: 0, stdout: output, stderr: "" }),
			list: async () => [],
			read: async () => "",
		});
		try {
			// When the maintenance admission reads the real strict property seam.
			await expect(
				recoverCrossSlot(fixture.identity, {
					...fixture.deps,
					probes: { ...fixture.deps.probes, unitAbsent: probes.unitAbsent },
				}),
			).rejects.toThrow("unit_unreadable");
			// Then no receipt or state mutation is authorized.
			expect(
				(await readdir(fixture.dir)).filter((name) =>
					name.startsWith("recovery-"),
				),
			).toEqual([]);
			expect(sha256(await readFile(join(fixture.dir, "agent.json")))).toBe(
				fixture.identity.agentSha256,
			);
		} finally {
			await fixture.close();
		}
	},
);

test("maintenance rejects overwritten backend masking evidence", async () => {
	const output =
		"LoadState=loaded\nLoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n";
	const probes = createRecoveryProbes({
		run: async () => ({ code: 0, stdout: output, stderr: "" }),
		list: async () => [],
		read: async () => "",
	});
	await expect(probes.backendStopped()).rejects.toThrow("unit_unreadable");
});

test("maintenance clean masked backend and absent commit unit remain admissible", async () => {
	const probes = createRecoveryProbes({
		run: async (argv) => ({
			code: 0,
			stderr: "",
			stdout: argv.includes("ceralive.service")
				? "LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n"
				: "LoadState=not-found\n",
		}),
		list: async () => [],
		read: async () => "",
	});
	expect(await probes.backendStopped()).toBe(true);
	expect(await probes.unitAbsent()).toBe(true);
});
