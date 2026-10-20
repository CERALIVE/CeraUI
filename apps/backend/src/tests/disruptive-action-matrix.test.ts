import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { createSeenCidStore } from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import type { Command, Result } from "../modules/remote-control/protocol.ts";
import { resetSelfFencingState } from "../modules/remote-control/self-fencing.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	resetOrchestratorRuntimeForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
} from "../modules/system/update-orchestrator/types.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";

// The contract, written independently of the gate: power is permitted only on
// confirmed idle stream evidence with no interruptible update work.
const streams = {
	streaming: () => updateStatus(true),
	idle: () => {},
	unknown: () => setStreamReconciliationCompletedForTest(false),
} as const;
const updates = {
	none: { interruptible: false, apply: () => {} },
	"os-staged receipt": {
		interruptible: false,
		apply: () => setPhase("os-staged"),
	},
	settled: { interruptible: false, apply: () => setPhase("settled") },
	downloading: { interruptible: true, apply: () => setPhase("downloading") },
	committing: { interruptible: true, apply: () => setPhase("committing") },
	"restarting-services": {
		interruptible: true,
		apply: () => setPhase("restarting-services"),
	},
	"os-staging": { interruptible: true, apply: () => setPhase("os-staging") },
	syncing: { interruptible: true, apply: () => setPhase("syncing") },
	"success awaiting durability": {
		interruptible: true,
		apply: () => {
			const baseline = {
				...initialOrchestratorState(1),
				phase: "committing" as const,
			};
			pendingPackageSuccess.retain(baseline, {
				...baseline,
				phase: "restarting-services",
			});
		},
	},
} as const;

function setPhase(phase: OrchestratorPhase): void {
	setOrchestratorStateForTest({ ...initialOrchestratorState(1), phase });
}

const context = buildControlContext();
const saved = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
	MARKER: process.env.CERALIVE_STREAMING_MARKER,
};
let dir = "";
let local: string[] = [];

beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	dir = mkdtempSync(join(tmpdir(), "disruptive-matrix-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	setStreamReconciliationCompletedForTest(true);
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	local = [];
	setPowerCommandRunner((command) => {
		local.push(command);
	});
});
afterEach(() => {
	if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = saved.NODE_ENV;
	if (saved.MOCK_MODE !== undefined) process.env.MOCK_MODE = saved.MOCK_MODE;
	if (saved.MARKER === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = saved.MARKER;
	resetPowerCommandRunner();
	resetSelfFencingState();
	resetOrchestratorRuntimeForTest();
	setStreamReconciliationCompletedForTest(true);
	updateStatus(false);
	rmSync(dir, { recursive: true, force: true });
});

async function runRemote(
	type: "system.reboot" | "device.factoryReset",
): Promise<boolean> {
	const submitted: unknown[] = [];
	const safe = Bun.spawnSync(["true"]);
	const spawn = spyOn(Bun, "spawnSync").mockImplementation((argv) => {
		submitted.push(argv);
		return safe;
	});
	const frame: Command = {
		v: 1,
		kind: "command",
		type,
		cid: `matrix-${type}`,
		role: "owner",
	};
	const deps = {
		context,
		seenCids: createSeenCidStore(),
		sendResult: (_: Result) => true,
		sendDeliveryAck: () => true,
	};
	try {
		await routeCommand(frame, deps);
		await routeCommand({ ...frame, type: "self_fencing.confirm" }, deps);
		return submitted.length > 0;
	} finally {
		spawn.mockRestore();
	}
}

const actions = {
	"local reboot": async () =>
		(await call(rebootProcedure, undefined, { context })).success &&
		local.length > 0,
	"local poweroff": async () =>
		(await call(poweroffProcedure, undefined, { context })).success &&
		local.length > 0,
	"remote reboot": () => runRemote("system.reboot"),
	"remote factory reset": () => runRemote("device.factoryReset"),
} as const;

for (const [stream, applyStream] of Object.entries(streams)) {
	for (const [update, { interruptible, apply }] of Object.entries(updates)) {
		for (const [action, run] of Object.entries(actions)) {
			test(`matrix: ${action} with stream ${stream} and update ${update}`, async () => {
				// Given real stream evidence and real update authority.
				applyStream();
				apply();
				// When the production entrypoint runs.
				const ran = await run();
				// Then it runs only on confirmed idle with nothing interruptible.
				expect(ran).toBe(stream === "idle" && !interruptible);
			});
		}
	}
}
