/*
 * Capture failover — the mid-stream standby/suspension/rate-adaptation verdicts
 * every live surface reads (LiveCockpit bands, LiveSourceSwitch chips and the
 * "Match this camera" action). Pure and rune-free, like live-source-state.ts.
 *
 * The wire shape is the producer's own `captureStatusSchema`
 * (`@ceralive/cerastream` 2026.9.11, schema 0.21.0): `state`, `suspension.kind`,
 * `active_source.{width,height,framerate,retimed,rescaled}` and
 * `failover_rate_policy`. Every status enum on that schema is OPEN (a plain
 * string), so an unknown future token must render NOTHING rather than a wrong
 * band — that is what most of the negatives below pin.
 */
import { describe, expect, it } from "vitest";

import {
	type CaptureStatus,
	deriveCaptureBands,
	deriveMatchAction,
	formatCaptureMode,
	isCaptureStandby,
	STANDBY_LEG_ID,
} from "./capture-failover";

function capture(overrides: Partial<CaptureStatus> = {}): CaptureStatus {
	return {
		state: "normal",
		live_inputs: ["cam0"],
		degraded_inputs: [],
		failover_rate_policy: "retime",
		...overrides,
	};
}

const BACKUP_1080P30 = {
	input_id: "cam1",
	width: 1920,
	height: 1080,
	framerate: 30,
	retimed: true,
	rescaled: false,
};

describe("formatCaptureMode — a source mode chip reads like a setting", () => {
	it("renders integer rates as <height>p<fps>", () => {
		expect(formatCaptureMode(1920, 1080, 30)).toBe("1080p30");
		expect(formatCaptureMode(1280, 720, 60)).toBe("720p60");
		expect(formatCaptureMode(3840, 2160, 25)).toBe("2160p25");
	});

	it("snaps NTSC fractional rates onto the ladder rung the dialog offers", () => {
		expect(formatCaptureMode(1920, 1080, 59.94005994)).toBe("1080p59.94");
		expect(formatCaptureMode(1920, 1080, 29.97002997)).toBe("1080p29.97");
	});

	it("keeps a rate the ladder has no rung for, rounded, rather than inventing one", () => {
		expect(formatCaptureMode(1920, 1080, 24)).toBe("1080p24");
		expect(formatCaptureMode(640, 480, 15)).toBe("480p15");
	});

	it("answers undefined when any dimension is missing or not finite", () => {
		expect(formatCaptureMode(undefined, 1080, 30)).toBeUndefined();
		expect(formatCaptureMode(1920, undefined, 30)).toBeUndefined();
		expect(formatCaptureMode(1920, 1080, undefined)).toBeUndefined();
		expect(formatCaptureMode(1920, 0, 30)).toBeUndefined();
		expect(formatCaptureMode(1920, 1080, Number.NaN)).toBeUndefined();
	});
});

describe("isCaptureStandby — standby is a typed state, never inferred", () => {
	it("is true when the engine reports capture.state === standby", () => {
		expect(isCaptureStandby(capture({ state: "standby" }), "cam0")).toBe(true);
	});

	it("is true when the running leg IS the standby leg, even with no capture block", () => {
		expect(isCaptureStandby(undefined, STANDBY_LEG_ID)).toBe(true);
	});

	it("is false for normal and degraded, and for an unknown future state", () => {
		expect(isCaptureStandby(capture({ state: "normal" }), "cam0")).toBe(false);
		expect(isCaptureStandby(capture({ state: "degraded" }), "cam0")).toBe(
			false,
		);
		expect(isCaptureStandby(capture({ state: "hibernating" }), "cam0")).toBe(
			false,
		);
		expect(isCaptureStandby(undefined, "cam0")).toBe(false);
		expect(isCaptureStandby(undefined, undefined)).toBe(false);
	});
});

describe("deriveCaptureBands — which mid-stream bands the capture block earns", () => {
	it("renders nothing for a normal, unsuspended session", () => {
		expect(deriveCaptureBands(capture())).toEqual([]);
		expect(deriveCaptureBands(undefined)).toEqual([]);
	});

	it("earns the standby band on state === standby", () => {
		expect(deriveCaptureBands(capture({ state: "standby" }))).toEqual([
			{ kind: "standby" },
		]);
	});

	it("maps each suspension kind onto its own band", () => {
		expect(
			deriveCaptureBands(
				capture({
					state: "degraded",
					suspension: {
						kind: "composition_primary_absent",
						since_ms: 1,
						resume_attempts: 0,
					},
				}),
			),
		).toEqual([{ kind: "composition-suspended" }]);
		expect(
			deriveCaptureBands(
				capture({
					state: "degraded",
					suspension: {
						kind: "passthrough_source_absent",
						since_ms: 1,
						resume_attempts: 0,
					},
				}),
			),
		).toEqual([{ kind: "passthrough-suspended" }]);
	});

	it("names the backup camera's mode on the rate-adapted band", () => {
		expect(
			deriveCaptureBands(
				capture({
					state: "degraded",
					suspension: { kind: "rate_adapted", since_ms: 1, resume_attempts: 0 },
					active_source: { ...BACKUP_1080P30, retimed: false },
				}),
			),
		).toEqual([{ kind: "rate-adapted", mode: "1080p30" }]);
	});

	it("still renders the rate-adapted band when the active source is unknown", () => {
		expect(
			deriveCaptureBands(
				capture({
					state: "degraded",
					suspension: { kind: "rate_adapted", since_ms: 1, resume_attempts: 0 },
				}),
			),
		).toEqual([{ kind: "rate-adapted", mode: undefined }]);
	});

	it("renders NO band for a suspension kind this build does not know", () => {
		expect(
			deriveCaptureBands(
				capture({
					state: "degraded",
					suspension: {
						kind: "gravity_reversed",
						since_ms: 1,
						resume_attempts: 0,
					},
				}),
			),
		).toEqual([]);
	});

	it("lists standby FIRST when a suspension is also reported", () => {
		const bands = deriveCaptureBands(
			capture({
				state: "standby",
				suspension: {
					kind: "composition_primary_absent",
					since_ms: 1,
					resume_attempts: 0,
				},
			}),
		);
		expect(bands[0]).toEqual({ kind: "standby" });
		expect(bands).toHaveLength(2);
	});
});

describe("deriveMatchAction — the offer to adopt the backup camera's mode", () => {
	it("offers the match when the active source is retimed under the retime policy", () => {
		expect(
			deriveMatchAction(capture({ active_source: BACKUP_1080P30 })),
		).toEqual({
			inputId: "cam1",
			mode: "1080p30",
			resolution: "1080p",
			framerate: 30,
		});
	});

	it("offers the match when the active source is rescaled but not retimed", () => {
		expect(
			deriveMatchAction(
				capture({
					active_source: {
						...BACKUP_1080P30,
						width: 1280,
						height: 720,
						framerate: 60,
						retimed: false,
						rescaled: true,
					},
				}),
			),
		).toEqual({
			inputId: "cam1",
			mode: "720p60",
			resolution: "720p",
			framerate: 60,
		});
	});

	it("snaps a fractional camera rate onto the persisted ladder", () => {
		expect(
			deriveMatchAction(
				capture({
					active_source: { ...BACKUP_1080P30, framerate: 59.94005994 },
				}),
			),
		).toEqual({
			inputId: "cam1",
			mode: "1080p59.94",
			resolution: "1080p",
			framerate: 59.94,
		});
	});

	it("offers nothing when the source already matches (neither retimed nor rescaled)", () => {
		expect(
			deriveMatchAction(
				capture({
					active_source: { ...BACKUP_1080P30, retimed: false, rescaled: false },
				}),
			),
		).toBeUndefined();
	});

	it("offers nothing under the adapt policy — the engine already matched it", () => {
		expect(
			deriveMatchAction(
				capture({
					failover_rate_policy: "adapt",
					active_source: BACKUP_1080P30,
				}),
			),
		).toBeUndefined();
	});

	it("offers nothing with no active source, and nothing on standby", () => {
		expect(deriveMatchAction(capture())).toBeUndefined();
		expect(
			deriveMatchAction(
				capture({ state: "standby", active_source: BACKUP_1080P30 }),
			),
		).toBeUndefined();
		expect(deriveMatchAction(undefined)).toBeUndefined();
	});

	it("offers nothing when the camera's mode cannot be saved as a setting", () => {
		// 24 fps has no rung on the offered ladder; a save would be refused.
		expect(
			deriveMatchAction(
				capture({ active_source: { ...BACKUP_1080P30, framerate: 24 } }),
			),
		).toBeUndefined();
		// A height below the smallest rung cannot be expressed as a resolution token.
		expect(
			deriveMatchAction(
				capture({
					active_source: { ...BACKUP_1080P30, width: 320, height: 240 },
				}),
			),
		).toBeUndefined();
	});
});
