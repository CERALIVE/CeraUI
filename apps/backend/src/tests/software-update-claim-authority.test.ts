/**
 * Every use of a unit's exit goes through its attempt's claim, taken at the
 * point of use: an exit nothing recorded, a claim an admission invalidated,
 * or a saved plan that is no longer the one that admitted the attempt never
 * reaches the tab or the orchestrator. Each attempt's unit carries its own
 * name, so retiring one can never reach another.
 */
import { expect, test } from "bun:test";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	type SoftwareUpdateAttempt,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	getLastInstallUnitVerdict,
	getPlanUpdateState,
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const FIXED = "ceralive-software-update.service";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INVOCATION_A = "a".repeat(32);
const INVOCATION_B = "b".repeat(32);
const unitOf = (attempt: string) =>
	`ceralive-software-update-${attempt}.service`;
const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const quiet = { onStdout: () => {}, onStderr: () => {} };

type Unit = {
	kind: "running" | "finished";
	readonly invocation: string;
	readonly exitCode: number;
};

// systemd's units by name and the device's record; a unit finishes on the
// next poll. Without a name a probe asks for the fixed unit, as before.
function device(o: {
	readonly units: Record<string, Unit>;
	readonly record: SoftwareUpdateAttempt | null;
	readonly failExitRecord?: boolean;
	readonly failCleanup?: (unit: string) => boolean;
	readonly onCleanup?: (unit: string) => void;
	/** Without a listing a probe sees only the fixed unit, as a test fake always did. */
	readonly unlisted?: boolean;
}) {
	let record = o.record;
	const cleanups: string[] = [];
	const started: (readonly string[])[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		uptimeMs: () => 1_000,
		readAttempt: () => record,
		updateAttempt: (change) => {
			const next = change(record);
			if (!next) return null;
			if (o.failExitRecord && next.exitCode !== undefined)
				throw new Error("ENOSPC: /run is full");
			record = next;
			return next;
		},
		prepareOutput: async () => {},
		start: async (command) => {
			started.push(command);
			const name =
				command
					.find((arg) => arg.startsWith("--unit="))
					?.slice("--unit=".length) ?? FIXED;
			o.units[name] = {
				kind: "running",
				invocation: INVOCATION_B,
				exitCode: 0,
			};
		},
		...(o.unlisted ? {} : { listUnits: async () => Object.keys(o.units) }),
		inspect: async (name = FIXED) => {
			const unit = o.units[name];
			if (!unit) return { kind: "absent" };
			return unit.kind === "running"
				? { kind: "running", invocation: unit.invocation }
				: {
						kind: "finished",
						exitCode: unit.exitCode,
						cleanup: unit.exitCode === 0 ? "stop" : "reset-failed",
						invocation: unit.invocation,
					};
		},
		cleanup: async (_state, name = FIXED) => {
			cleanups.push(name);
			o.onCleanup?.(name);
			if (o.failCleanup?.(name)) throw new Error("systemctl stop failed");
			delete o.units[name];
		},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {
			for (const unit of Object.values(o.units))
				if (unit.kind === "running") unit.kind = "finished";
		},
	};
	return { deps, cleanups, started, record: () => record };
}

const recovery = (deps: DetachedAptUpgradeDeps) => ({
	recover: (
		handlers: Parameters<typeof recoverDetachedAptUpgrade>[0],
		_deps?: DetachedAptUpgradeDeps,
		options?: Parameters<typeof recoverDetachedAptUpgrade>[2],
	) => recoverDetachedAptUpgrade(handlers, deps, options),
	scheduleRetry: () => {},
	resumePeriodicChecks: () => {},
});

const launchedA: SoftwareUpdateAttempt = {
	schema: 2,
	attempt: A,
	phase: "launched",
	uptimeMs: 1_000,
	invocation: INVOCATION_A,
};

test("a unit's exit nothing could record is no outcome: the tab is not told it", async () => {
	await using h = await updateHarness();
	// A's own unit, running, the way every release observes it.
	const system = device({
		units: {
			[FIXED]: { kind: "running", invocation: INVOCATION_A, exitCode: 0 },
		},
		record: launchedA,
		failExitRecord: true,
		unlisted: true,
	});
	// The install ends with an outcome, or with none (`updating: null`).
	const ended = Promise.withResolvers<void>();
	h.onFrame = (frame) => {
		if (frame.updating === null || frame.update_state?.kind === "success")
			ended.resolve();
	};
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recovery(system.deps))).toBe(
		true,
	);
	await ended.promise;
	expect(getUpdateState().kind).not.toBe("success");
	expect(h.frames.some((f) => f.update_state?.kind === "success")).toBe(false);
	expect(h.restarts).toBe(0);
	// Without a durable record the finished unit stays as the evidence.
	expect(system.cleanups).toEqual([]);
});

test("a finished unit's recorded exit is claimed again after its retirement: an admission meanwhile tells nothing", async () => {
	await using h = await updateHarness();
	const system = device({
		units: {
			[unitOf(A)]: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		},
		record: { ...launchedA, exitCode: 0, drained: true },
		// Attempt B is admitted while A's unit is being retired.
		onCleanup: () =>
			system.deps.updateAttempt(() => ({
				schema: 2,
				attempt: B,
				phase: "accepted",
				uptimeMs: 1_000,
			})),
	});
	beginSoftwareUpdateRecovery();
	await recoverSoftwareUpdateIfRunning(recovery(system.deps));
	expect(buildInitialStatus().status.update_state?.kind).not.toBe("success");
	expect(h.frames.some((f) => f.update_state?.kind === "success")).toBe(false);
});

test("a finished leftover that cannot be retired is not reported as absence", async () => {
	await using _h = await updateHarness();
	const system = device({
		units: {
			[unitOf(A)]: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		},
		record: {
			schema: 2,
			attempt: B,
			phase: "accepted",
			uptimeMs: 1_000,
			leftover: {
				attempt: A,
				invocation: INVOCATION_A,
				exitCode: 0,
				drained: true,
			},
		},
		failCleanup: () => true,
	});
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recovery(system.deps))).toBe(
		false,
	);
	// The unit is still there: that is not proof that nothing survived.
	expect(getLastInstallUnitVerdict()).not.toBe("absent");
});

test("an attempt's success settles the orchestrator's plan only while that plan is still the saved one", async () => {
	await using h = await updateHarness();
	h.completion = Promise.resolve(0);
	startSoftwareUpdate(() => {});
	await h.check();
	expect(getPlanUpdateState().kind).toBe("success");
	// Another plan is saved now, as an older release saves its own after a rollback.
	h.plan = "f".repeat(64);
	expect(getPlanUpdateState().kind).toBe("idle");
	// The tab is still told what the device did.
	expect(getUpdateState().kind).toBe("success");
});

test("each attempt's unit is named for it: retiring an earlier attempt's unit never reaches a successor's", async () => {
	const unitA = unitOf(A);
	const units: Record<string, Unit> = {
		[unitA]: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
	};
	const system = device({
		units,
		record: { ...launchedA, exitCode: 0, drained: true },
		// A's unit can never be retired.
		failCleanup: (name) => name === unitA,
	});
	expect(await runDetachedAptAll(args, "any", quiet, system.deps)).toBe(0);
	const successor = system.record()?.attempt ?? "";
	expect(successor).not.toBe(A);
	expect(system.started[0]).toContain(`--unit=${unitOf(successor)}`);
	// Every retirement named its own attempt's unit; A's stays as the evidence.
	expect(system.cleanups.filter((name) => name !== unitA)).toEqual([
		unitOf(successor),
	]);
	expect(Object.keys(units)).toEqual([unitA]);
});
