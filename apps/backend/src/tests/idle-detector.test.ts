import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	getLastRemoteCommandAt,
	hasActiveRemoteSession,
	resetRemoteCommandActivityForTest,
	routeCommand,
	setRemoteCommandClockForTest,
} from "../modules/remote-control/command-router.ts";
import type { Command } from "../modules/remote-control/protocol.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	getIdleStatus,
	setIdleStateFilePathForTest,
} from "../modules/system/idle-activity.ts";
import { evaluateIdle } from "../modules/system/idle-detector.ts";
import { loadIdleState } from "../modules/system/idle-state.ts";
import { heartbeatProcedure } from "../rpc/procedures/ui.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const minute = 60_000;
const now = Date.parse("2026-09-24T00:30:00Z");
const dir = mkdtempSync(join(tmpdir(), "ceraui-idle-"));
const file = join(dir, "state.json");

afterEach(() => {
	jest.useRealTimers();
	resetLifecycleInterlock();
	resetRemoteCommandActivityForTest();
	setRemoteCommandClockForTest(null);
	updateStatus(false);
	setIdleStateFilePathForTest(null);
	rmSync(file, { force: true });
});

const context = (authenticated: boolean): RPCContext => ({
	ws: { data: { isAuthenticated: authenticated } } as AppWebSocket,
	isAuthenticated: () => authenticated,
	authenticate: () => {},
	deauthenticate: () => {},
	markActive: () => {},
	getLastActive: () => 0,
	setSenderId: () => {},
	getSenderId: () => undefined,
	clearSenderId: () => {},
});

describe("pure idle decision", () => {
	const quiet = {
		stream: now - 30 * minute,
		preview: null,
		remote: null,
		ui: null,
		startLease: null,
	};
	const schedule = { mode: "any-idle", start: "03:00", end: "05:00" } as const;

	test("at exactly 30 minutes the last activity no longer blocks", () => {
		expect(
			evaluateIdle({ now, lastActivity: quiet, schedule, idleMinutes: 30 }),
		).toEqual({
			idle: true,
			since: quiet.stream,
			blockers: [],
		});
		expect(
			evaluateIdle({
				now: now - 1,
				lastActivity: quiet,
				schedule,
				idleMinutes: 30,
			}).blockers,
		).toEqual(["stream"]);
	});

	for (const blocker of [
		"stream",
		"preview",
		"remote",
		"ui",
		"startLease",
	] as const) {
		test(`${blocker} alone blocks idle`, () => {
			const result = evaluateIdle({
				now,
				lastActivity: { ...quiet, [blocker]: now },
				schedule,
				idleMinutes: 30,
			});
			expect(result).toEqual({ idle: false, since: now, blockers: [blocker] });
		});
	}

	test("window includes start and excludes end, including midnight", () => {
		const window = { mode: "window", start: "23:00", end: "01:00" } as const;
		for (const [instant, allowed] of [
			["2026-09-23T22:59:00Z", false],
			["2026-09-23T23:00:00Z", true],
			["2026-09-24T00:30:00Z", true],
			["2026-09-24T01:00:00Z", false],
		] as const) {
			const at = Date.parse(instant);
			const result = evaluateIdle({
				now: at,
				lastActivity: { ...quiet, stream: at - 31 * minute },
				schedule: window,
				idleMinutes: 30,
			});
			expect(result.idle).toBe(allowed);
			expect(result.blockers).toEqual(allowed ? [] : ["schedule"]);
		}
	});

	test("no activity baseline cannot assert 30 minutes idle", () => {
		expect(
			evaluateIdle({
				now,
				lastActivity: {
					stream: null,
					preview: null,
					remote: null,
					ui: null,
					startLease: null,
				},
				schedule,
				idleMinutes: 30,
			}).idle,
		).toBe(false);
	});
});

describe("live idle signals", () => {
	test("remote command recency includes exactly five minutes, never hub connection", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date(now));
		setRemoteCommandClockForTest(() => Date.now());
		expect(hasActiveRemoteSession()).toBe(false);
		await routeCommand(
			{
				v: 1,
				kind: "command",
				type: "streaming.getConfig",
				cid: "idle-recency",
				role: "owner",
			} satisfies Command,
			{
				sendResult: () => true,
				sendDeliveryAck: () => true,
				dispatch: { "streaming.getConfig": async () => ({}) },
			},
		);
		expect(getLastRemoteCommandAt()).toBe(now);
		expect(hasActiveRemoteSession()).toBe(true);
		jest.setSystemTime(new Date(now + 5 * minute));
		expect(hasActiveRemoteSession()).toBe(true);
		jest.setSystemTime(new Date(now + 5 * minute + 1));
		expect(hasActiveRemoteSession()).toBe(false);
	});

	test("authenticated heartbeat updates idle state; unauthenticated call is rejected", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date(now));
		setIdleStateFilePathForTest(file);
		let refused = false;
		try {
			await call(heartbeatProcedure, undefined, { context: context(false) });
		} catch (error) {
			refused = error instanceof Error;
		}
		expect(refused).toBe(true);
		expect(
			await call(heartbeatProcedure, undefined, { context: context(true) }),
		).toEqual({ success: true });
		expect(
			(
				await getIdleStatus({
					now,
					schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				})
			).blockers,
		).toContain("ui");
	});

	test("stream stop timestamp is durable and reloadable after restart", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date(now));
		setIdleStateFilePathForTest(file);
		updateStatus(true);
		updateStatus(false);
		expect(JSON.parse(readFileSync(file, "utf8")).lastStreamEndedAt).toBe(now);
		setIdleStateFilePathForTest(file);
		expect(await loadIdleState()).toBe(now);
	});

	test("an admitted start lease prevents idle before streaming begins", async () => {
		setIdleStateFilePathForTest(file);
		const admission = tryAcquireLifecycle("streaming");
		expect(admission.admitted).toBe(true);
		if (!admission.admitted) return;
		try {
			expect(
				(
					await getIdleStatus({
						now,
						schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
					})
				).blockers,
			).toContain("startLease");
		} finally {
			admission.lease.release();
		}
	});
});
