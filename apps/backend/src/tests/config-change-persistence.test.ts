/*
 * Staged persistence for an apply-now config change (device-quality-wave3 todo 12).
 *
 * The rule these cases lock: `config.json` describes what the ENGINE IS
 * RUNNING. So an apply-now candidate is held off disk for the whole
 * transaction, and only `applied` writes it. A `reverted` or `rollback_failed`
 * must leave the persisted values byte-identical, because those values are
 * still the ones the engine is running.
 *
 * These drive the REAL procedure for the same reason the device-truth suite
 * does: the guarantee has to hold for a direct RPC call, not just the dialog.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConfigChangeResult } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	type ApplyNowGate,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import {
	clearStagedConfigChange,
	getStagedConfigChange,
	type InflightConfigMarker,
	type StagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function memoryDeps(seed?: InflightConfigMarker): StagingDeps {
	let contents: string | undefined =
		seed === undefined ? undefined : JSON.stringify(seed);
	return {
		markerPath: "config.inflight.json",
		readMarker: () => contents,
		writeMarker: (_path, next) => {
			contents = next;
		},
		removeMarker: () => {
			contents = undefined;
		},
	};
}

function gate(
	outcome: ConfigChangeResult,
	live = true,
): ApplyNowGate & { deltas: unknown[] } {
	const deltas: unknown[] = [];
	return {
		deltas,
		isStreamLive: () => live,
		dispatch: async (delta) => {
			deltas.push(delta);
			return outcome;
		},
	};
}

const APPLIED: ConfigChangeResult = { result: "applied", attemptId: "a1" };
const REVERTED: ConfigChangeResult = {
	result: "reverted",
	attemptId: "a1",
	reason: "not_negotiated",
};
const ROLLBACK_FAILED: ConfigChangeResult = {
	result: "rollback_failed",
	attemptId: "a1",
	reason: "teardown_timeout",
};

describe("apply-now staged persistence", () => {
	let prior: {
		resolution: ReturnType<typeof getConfig>["resolution"];
		framerate: ReturnType<typeof getConfig>["framerate"];
	};

	beforeEach(() => {
		const config = getConfig();
		prior = { resolution: config.resolution, framerate: config.framerate };
		config.resolution = "1080p";
		config.framerate = 30;
	});

	afterEach(() => {
		const config = getConfig();
		config.resolution = prior.resolution;
		config.framerate = prior.framerate;
		setApplyNowGateForTest(null);
		clearStagedConfigChange(memoryDeps());
	});

	test("applied is the ONLY outcome that writes config.json", async () => {
		// Given a live stream and an apply-now change to 2160p.
		setApplyNowGateForTest(gate(APPLIED));

		// When the transaction applies.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then the candidate is persisted and echoed, and no marker survives.
		expect(result.success).toBe(true);
		expect(result.configChange).toEqual(APPLIED);
		expect(getConfig().resolution).toBe("2160p");
		expect(result.applied?.resolution).toBe("2160p");
		expect(getStagedConfigChange()).toBeUndefined();
	});

	test("reverted leaves the persisted values UNTOUCHED", async () => {
		// Given a live stream at 1080p.
		setApplyNowGateForTest(gate(REVERTED));

		// When the engine refuses the new geometry and restores the old one.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then disk still describes what the engine is running.
		expect(getConfig().resolution).toBe("1080p");
		expect(result.configChange).toEqual(REVERTED);
		expect(getStagedConfigChange()).toBeUndefined();
	});

	test("rollback_failed leaves the persisted values UNTOUCHED", async () => {
		// Given a live stream at 1080p.
		setApplyNowGateForTest(gate(ROLLBACK_FAILED));

		// When even the rollback fails and the engine goes Idle.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then the operator's last WORKING config is what boots next time.
		expect(getConfig().resolution).toBe("1080p");
		expect(result.success).toBe(false);
		expect(result.configChange).toEqual(ROLLBACK_FAILED);
	});

	test("non-restart fields in the SAME save still persist immediately", async () => {
		// Given an apply-now save that also flips the bitrate overlay.
		setApplyNowGateForTest(gate(REVERTED));
		const priorOverlay = getConfig().bitrate_overlay;

		// When the geometry change reverts.
		await call(
			setConfigProcedure,
			{ resolution: "2160p", bitrate_overlay: true, apply_now: true },
			{ context: makeContext() },
		);

		// Then only the restart-requiring half was held back.
		expect(getConfig().bitrate_overlay).toBe(true);
		expect(getConfig().resolution).toBe("1080p");
		getConfig().bitrate_overlay = priorOverlay;
	});

	test("only the graph-baked fields reach the engine delta", async () => {
		// Given an apply-now save carrying a live-adjustable field too.
		const g = gate(APPLIED);
		setApplyNowGateForTest(g);

		// When it is dispatched.
		await call(
			setConfigProcedure,
			{
				resolution: "2160p",
				framerate: 30,
				bitrate_overlay: false,
				apply_now: true,
			},
			{ context: makeContext() },
		);

		// Then the transaction carries geometry only — never the overlay.
		expect(g.deltas).toEqual([{ resolution: "2160p", framerate: 30 }]);
	});
});

describe("apply-now falls back rather than surprising the operator", () => {
	afterEach(() => setApplyNowGateForTest(null));

	test("apply_now while NOT streaming persists normally and dispatches nothing", async () => {
		// Given an idle device.
		const g = gate(APPLIED, false);
		setApplyNowGateForTest(g);
		const config = getConfig();
		const priorResolution = config.resolution;

		// When apply-now is requested anyway (a race with the stream stopping).
		const result = await call(
			setConfigProcedure,
			{ resolution: "720p", apply_now: true },
			{ context: makeContext() },
		);

		// Then it degrades to the ordinary save — no transaction, no surprise.
		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(getConfig().resolution).toBe("720p");
		expect(g.deltas).toEqual([]);
		config.resolution = priorResolution;
	});

	test("the DEFAULT save (no apply_now) is the unchanged apply-on-next-start path", async () => {
		// Given a LIVE stream — the case where a restart would be most disruptive.
		const g = gate(APPLIED, true);
		setApplyNowGateForTest(g);
		const config = getConfig();
		const priorResolution = config.resolution;

		// When an ordinary save arrives with no apply_now directive.
		const result = await call(
			setConfigProcedure,
			{ resolution: "720p" },
			{ context: makeContext() },
		);

		// Then it persists immediately and NEVER restarts the stream.
		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(g.deltas).toEqual([]);
		expect(getConfig().resolution).toBe("720p");
		config.resolution = priorResolution;
	});
});

describe("crash-window reconciliation through the real writer", () => {
	test("NO marker ⇒ an apply-on-next-start mismatch survives a restart untouched", () => {
		// Given config.json holding the operator's 2160p "apply on next start"
		// intent while the engine is still live on the old 1080p — and NO marker.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "2160p";

		// When the backend restarts and reconciliation runs.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "1920x1080",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			memoryDeps(),
		);

		// Then nothing is reconciled — the operator's intent is preserved.
		expect(verdict).toBe("no_marker");
		expect(getConfig().resolution).toBe("2160p");
		config.resolution = priorResolution;
	});

	test("marker present + engine on the CANDIDATE ⇒ the candidate is persisted", () => {
		// Given a crash between `applied` and the config write.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When the engine is found live on the candidate with frames advancing.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "2160p",
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			deps,
		);

		// Then the write that the crash lost is completed.
		expect(verdict).toBe("persisted_candidate");
		expect(getConfig().resolution).toBe("2160p");
		config.resolution = priorResolution;
	});

	test("marker present + engine on the PREVIOUS params ⇒ old values retained", () => {
		// Given the same crash but the change never took.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When the engine is found live on the pre-change geometry.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "1080p",
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			deps,
		);

		// Then disk is left alone and the marker is retired.
		expect(verdict).toBe("retained_previous");
		expect(getConfig().resolution).toBe("1080p");
		config.resolution = priorResolution;
	});

	test("marker present + engine undecided ⇒ nothing written, marker KEPT", () => {
		// Given an engine that cannot be reached at reconciliation time.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When reconciliation runs with no engine snapshot.
		const verdict = reconcileInflightConfigChange(undefined, deps);

		// Then it defers — and the marker is still there for the next reconnect.
		expect(verdict).toBe("deferred");
		expect(getConfig().resolution).toBe("1080p");
		expect(deps.readMarker(deps.markerPath)).toBeDefined();
		config.resolution = priorResolution;
	});
});
