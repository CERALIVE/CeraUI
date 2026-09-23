import { afterEach, expect, test } from "bun:test";
import { captureStatusSchema } from "@ceralive/cerastream";
import { captureSourceSchema } from "@ceraui/rpc/schemas";
import {
	CAPTURE_STANDBY_LONG_NOTICE_MS,
	noteCaptureStatus,
	setCaptureResilienceDepsForTest,
} from "../modules/streaming/capture-resilience.ts";

const sources = [
	["camera-a", "Osmo Pocket"],
	["camera-b", "HDMI Input"],
	["camera-c", "BRIO"],
].map(([id, displayName]) =>
	captureSourceSchema.parse({
		id,
		displayName,
		origin: "capture",
		kind: "hdmi",
		devicePath: id,
		pipelineId: "hdmi",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "none",
		available: true,
	}),
);

function fixture(overrides: Record<string, unknown> = {}) {
	return captureStatusSchema.parse({
		state: "normal",
		live_inputs: ["camera-a", "camera-b"],
		degraded_inputs: [],
		failover_rate_policy: "retime",
		...overrides,
	});
}

function harness() {
	let now = 10_000;
	let next = 0;
	const timers = new Map<number, () => void>();
	const shown: Array<{
		name: string;
		msg: string;
		key: string | undefined;
		params: Record<string, unknown> | undefined;
		persistent: boolean;
	}> = [];
	const removed: string[] = [];
	setCaptureResilienceDepsForTest({
		sources: () => sources,
		now: () => now,
		setTimer: (fn) => {
			const id = ++next;
			timers.set(id, fn);
			return id;
		},
		clearTimer: (id) => {
			if (typeof id === "number") timers.delete(id);
		},
		notify: (
			name,
			_type,
			msg,
			_duration,
			persistent,
			_dismissable,
			_authed,
			key,
			params,
		) => {
			shown.push({ name, msg, key, params, persistent });
		},
		removeNotification: (name) => {
			removed.push(name);
		},
	});
	return {
		shown,
		removed,
		advance: (ms: number) => {
			now += ms;
		},
		fire: () => {
			for (const [id, fn] of [...timers]) {
				timers.delete(id);
				fn();
			}
		},
		pending: () => timers.size,
	};
}

afterEach(() => setCaptureResilienceDepsForTest(null));

test("standby raises and retracts from structured status, without a new engine action", () => {
	const h = harness();
	noteCaptureStatus(
		fixture({ state: "standby", live_inputs: [], standby_since_ms: 10_000 }),
		true,
	);
	expect(h.shown.map((n) => n.name)).toEqual(["capture-standby"]);
	expect(h.shown[0]?.persistent).toBe(true);
	noteCaptureStatus(fixture(), true);
	expect(h.removed).toEqual(["capture-standby"]);
	expect(h.pending()).toBe(0);
});

test("each lost camera has its own retractable id but only product names enter operator copy", () => {
	const h = harness();
	noteCaptureStatus(
		fixture({
			state: "degraded",
			live_inputs: ["camera-b"],
			degraded_inputs: [{ input_id: "camera-a" }],
			active_source: {
				input_id: "camera-b",
				width: 1920,
				height: 1080,
				framerate: 30,
				retimed: false,
				rescaled: false,
			},
		}),
		true,
	);
	expect(h.shown[0]).toMatchObject({
		name: "capture-input-lost:camera-a",
		params: { name: "Osmo Pocket", activeCamera: "HDMI Input" },
	});
	expect(h.shown[0]?.msg).not.toContain("camera-a");
	expect(h.shown[0]?.msg).not.toContain("camera-b");
	noteCaptureStatus(fixture(), true);
	expect(h.removed).toContain("capture-input-lost:camera-a");
});

test("unresolved device ids never leak into a notice", () => {
	const h = harness();
	noteCaptureStatus(
		fixture({
			state: "degraded",
			live_inputs: ["camera-b"],
			degraded_inputs: [{ input_id: "/dev/video9" }],
			active_source: {
				input_id: "camera-b",
				width: 1920,
				height: 1080,
				framerate: 30,
				retimed: false,
				rescaled: false,
			},
		}),
		true,
	);
	expect(h.shown.map((n) => n.name)).toEqual([]);
});

test("two lost cameras keep separate notice identities and recover independently", () => {
	const h = harness();
	const withThird = fixture({
		state: "degraded",
		live_inputs: ["camera-b"],
		degraded_inputs: [{ input_id: "camera-a" }, { input_id: "camera-c" }],
	});
	noteCaptureStatus(withThird, true);
	expect(h.shown.map((n) => n.name)).toEqual([
		"capture-input-lost:camera-a",
		"capture-input-lost:camera-c",
	]);
	noteCaptureStatus(
		fixture({
			state: "degraded",
			live_inputs: ["camera-b"],
			degraded_inputs: [{ input_id: "camera-c" }],
		}),
		true,
	);
	expect(h.removed).toContain("capture-input-lost:camera-a");
	expect(h.removed).not.toContain("capture-input-lost:camera-c");
});

test("long standby uses a fake clock and continuous-run deadline; recovery cancels it", () => {
	const h = harness();
	noteCaptureStatus(
		fixture({ state: "standby", live_inputs: [], standby_since_ms: 10_000 }),
		true,
	);
	h.advance(CAPTURE_STANDBY_LONG_NOTICE_MS - 1);
	noteCaptureStatus(
		fixture({ state: "standby", live_inputs: [], standby_since_ms: 10_000 }),
		true,
	);
	expect(h.shown.map((n) => n.name)).toEqual(["capture-standby"]);
	h.advance(1);
	h.fire();
	expect(h.shown.map((n) => n.name)).toEqual([
		"capture-standby",
		"capture-standby-long",
	]);
	noteCaptureStatus(fixture(), true);
	expect(h.removed).toContain("capture-standby-long");
	noteCaptureStatus(
		fixture({ state: "standby", live_inputs: [], standby_since_ms: 610_001 }),
		true,
	);
	expect(h.shown.filter((n) => n.name === "capture-standby-long")).toHaveLength(
		1,
	);
});

test("suspensions and rate adaptation each retract when their kind ends", () => {
	const h = harness();
	for (const [kind, name] of [
		["composition_primary_absent", "capture-composition-suspended"],
		["passthrough_source_absent", "capture-passthrough-suspended"],
		["rate_adapted", "capture-rate-adapted"],
	] as const) {
		noteCaptureStatus(
			fixture({ suspension: { kind, since_ms: 10_000, resume_attempts: 0 } }),
			true,
		);
		expect(h.shown[h.shown.length - 1]?.name).toBe(name);
		noteCaptureStatus(fixture(), true);
		expect(h.removed[h.removed.length - 1]).toBe(name);
	}
});
