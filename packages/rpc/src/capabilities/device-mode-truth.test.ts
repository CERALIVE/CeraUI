/*
 * The exact-capability contract (cerastream ADR-0008 §10), as ONE shared rule.
 *
 * "The per-`media_type` mode ladder is the ONLY truth. A resolution offered under
 * `video/x-h264` says nothing about what `image/jpeg` offers on the same device.
 * The UI and the save path may never invent or union."
 *
 * These cases pin the rule BOTH consumers now share — the frontend
 * `ValidationAdapter` (what the operator is offered) and the backend
 * `streaming.setConfig` (what may be persisted). They must never disagree: an
 * offering the save path would reject is a lie, and a save the offering would
 * have disabled is a bypass.
 */

import { describe, expect, test } from 'bun:test';

import type { DeviceMode } from '../schemas/streaming.schema';
import {
	activeMediaTypeForModes,
	evaluateDeviceMode,
	nearestDeliverableMode,
	scopeModesToMediaType,
	singleModeSourceCeiling,
} from './device-mode-truth';

const H264 = 'video/x-h264';
const H265 = 'video/x-h265';
const MJPEG = 'image/jpeg';
const RAW = 'video/x-raw';

function mode(
	width: number,
	height: number,
	framerates: number[],
	media_type?: string,
): DeviceMode {
	return { width, height, framerates, ...(media_type !== undefined ? { media_type } : {}) };
}

/**
 * The effort's running example — a DJI Osmo Pocket 3 whose H.264 ladder tops out
 * at 30 fps at 1080p while its MJPEG ladder reaches 60. Unioning the two is the
 * exact #244 defect: it offers 1080p60 to an H.264 capture that cannot deliver it.
 */
const OSMO_MODES: DeviceMode[] = [
	mode(1920, 1080, [30], H264),
	mode(1280, 720, [30, 60], H264),
	mode(1920, 1080, [30, 60], MJPEG),
	mode(3840, 2160, [30], MJPEG),
];

describe('activeMediaTypeForModes — the kind NAMES the governing ladder', () => {
	test('a uvc_h264 source is governed by the H.264 ladder', () => {
		expect(activeMediaTypeForModes(OSMO_MODES, 'uvc_h264')).toBe(H264);
	});

	test('an mjpeg source is governed by the image/jpeg ladder', () => {
		expect(activeMediaTypeForModes(OSMO_MODES, 'mjpeg')).toBe(MJPEG);
	});

	test('a uvc_h265 source is governed by the H.265 ladder', () => {
		const modes = [mode(1920, 1080, [30], H264), mode(1920, 1080, [60], H265)];
		expect(activeMediaTypeForModes(modes, 'uvc_h265')).toBe(H265);
	});

	// Fail-open guard 1: nothing to disambiguate.
	test('fewer than two advertised media types narrows NOTHING', () => {
		expect(activeMediaTypeForModes([mode(1920, 1080, [30], H264)], 'uvc_h264')).toBeUndefined();
		expect(activeMediaTypeForModes([mode(1920, 1080, [30])], 'uvc_h264')).toBeUndefined();
	});

	// Fail-open guard 2: never narrow on a guess.
	test('a kind naming none of the advertised media types narrows NOTHING', () => {
		expect(activeMediaTypeForModes(OSMO_MODES, 'hdmi')).toBeUndefined();
	});

	test('an absent kind or absent modes narrows NOTHING', () => {
		expect(activeMediaTypeForModes(OSMO_MODES, undefined)).toBeUndefined();
		expect(activeMediaTypeForModes(undefined, 'uvc_h264')).toBeUndefined();
	});

	test('video/x-raw is disambiguated by the kind itself (camlink vs hdmi)', () => {
		const modes = [mode(1920, 1080, [30], RAW), mode(1920, 1080, [60], MJPEG)];
		expect(activeMediaTypeForModes(modes, 'camlink')).toBe(RAW);
		expect(activeMediaTypeForModes(modes, 'hdmi')).toBe(RAW);
	});
});

describe('scopeModesToMediaType', () => {
	test('keeps only the governing ladder', () => {
		const scoped = scopeModesToMediaType(OSMO_MODES, H264);
		expect(scoped?.map((m) => m.media_type)).toEqual([H264, H264]);
	});

	// An untagged mode carries no format constraint, so it can never be PROVEN to
	// belong to another ladder.
	test('an UNTAGGED mode is always kept', () => {
		const modes = [mode(1920, 1080, [30], H264), mode(1280, 720, [60])];
		expect(scopeModesToMediaType(modes, H264)).toHaveLength(2);
	});

	test('returns the input array UNCHANGED (same reference) when nothing is dropped', () => {
		const modes = [mode(1920, 1080, [30], H264)];
		expect(scopeModesToMediaType(modes, H264)).toBe(modes);
		expect(scopeModesToMediaType(modes, undefined)).toBe(modes);
	});

	test('falls back to the whole list rather than emptying it', () => {
		const modes = [mode(1920, 1080, [30], H264)];
		expect(scopeModesToMediaType(modes, MJPEG)).toBe(modes);
	});
});

describe('singleModeSourceCeiling — a reported SIGNAL is a ceiling, not a menu', () => {
	test('one rung on both axes is a ceiling', () => {
		expect(singleModeSourceCeiling([mode(1920, 1080, [59.94])])).toEqual({
			resolution: '1080p',
			framerate: 59.94,
		});
	});

	test('an enumerated menu is NOT a ceiling', () => {
		expect(singleModeSourceCeiling(OSMO_MODES)).toBeUndefined();
	});

	test('fail-closed: a modeless source and un-normalizable rungs yield no ceiling', () => {
		expect(singleModeSourceCeiling([])).toBeUndefined();
		expect(singleModeSourceCeiling(undefined)).toBeUndefined();
		expect(singleModeSourceCeiling([mode(64, 48, [7])])).toBeUndefined();
	});
});

describe('evaluateDeviceMode — the save-path verdict (ADR-0008 §10)', () => {
	// ── The class this todo kills ───────────────────────────────────────────────
	test('1080p60 on the Osmo H.264 ladder is REFUSED (the #244 union defect)', () => {
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '1080p',
				framerate: 60,
			}),
		).toEqual({ supported: false, reason: 'mode_not_enumerated' });
	});

	test('1080p30 on the SAME device+ladder is allowed', () => {
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '1080p',
				framerate: 30,
			}),
		).toEqual({ supported: true });
	});

	test('720p60 is allowed on H.264 — the rate exists at THAT rung', () => {
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '720p',
				framerate: 60,
			}),
		).toEqual({ supported: true });
	});

	test('1080p60 IS allowed on the same device as MJPEG — ladders are per-media_type', () => {
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'mjpeg',
				resolution: '1080p',
				framerate: 60,
			}),
		).toEqual({ supported: true });
	});

	test('2160p is refused on H.264 and allowed on MJPEG', () => {
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '2160p',
				framerate: 30,
			}),
		).toEqual({ supported: false, reason: 'mode_not_enumerated' });
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'mjpeg',
				resolution: '2160p',
				framerate: 30,
			}),
		).toEqual({ supported: true });
	});

	// ── The ceiling model must be honoured, or the save path would refuse what
	//    the dialog legitimately offers on an HDMI receiver.
	describe('a single-mode source is a CEILING (downscale/rate-reduce always available)', () => {
		const HDMI_1080P5994 = [mode(1920, 1080, [59.94])];

		test('at the ceiling', () => {
			expect(
				evaluateDeviceMode({
					modes: HDMI_1080P5994,
					kind: 'hdmi',
					resolution: '1080p',
					framerate: 59.94,
				}),
			).toEqual({ supported: true });
		});

		test('below the ceiling on both axes', () => {
			expect(
				evaluateDeviceMode({
					modes: HDMI_1080P5994,
					kind: 'hdmi',
					resolution: '720p',
					framerate: 30,
				}),
			).toEqual({ supported: true });
		});

		test('above the ceiling by resolution', () => {
			expect(
				evaluateDeviceMode({
					modes: HDMI_1080P5994,
					kind: 'hdmi',
					resolution: '2160p',
					framerate: 30,
				}),
			).toEqual({ supported: false, reason: 'resolution_above_source_signal' });
		});

		test('above the ceiling by framerate', () => {
			expect(
				evaluateDeviceMode({
					modes: HDMI_1080P5994,
					kind: 'hdmi',
					resolution: '1080p',
					framerate: 60,
				}),
			).toEqual({ supported: false, reason: 'framerate_above_source_signal' });
		});
	});

	// ── Fail-open: an unknown NEVER subtracts ──────────────────────────────────
	describe('fail-open — the engine reported no truth, so nothing is refused', () => {
		test('a source with no modes', () => {
			expect(
				evaluateDeviceMode({ modes: [], kind: 'uvc_h264', resolution: '2160p', framerate: 60 }),
			).toEqual({ supported: true });
			expect(
				evaluateDeviceMode({
					modes: undefined,
					kind: 'uvc_h264',
					resolution: '2160p',
					framerate: 60,
				}),
			).toEqual({ supported: true });
		});

		test('an axis the caller did not ask about is not checked', () => {
			expect(
				evaluateDeviceMode({ modes: OSMO_MODES, kind: 'uvc_h264', resolution: '1080p' }),
			).toEqual({ supported: true });
			expect(evaluateDeviceMode({ modes: OSMO_MODES, kind: 'uvc_h264', framerate: 60 })).toEqual({
				supported: true,
			});
		});

		test('modes whose rungs do not normalize can never refuse', () => {
			expect(
				evaluateDeviceMode({
					modes: [mode(64, 48, [7]), mode(72, 52, [9])],
					kind: 'uvc_h264',
					resolution: '1080p',
					framerate: 60,
				}),
			).toEqual({ supported: true });
		});

		test('an unmatched kind falls back to the WHOLE ladder, never a guess', () => {
			// `hdmi` names none of the Osmo's advertised formats, so nothing is
			// scoped away and 1080p60 (real, under MJPEG) stays allowed.
			expect(
				evaluateDeviceMode({
					modes: OSMO_MODES,
					kind: 'hdmi',
					resolution: '1080p',
					framerate: 60,
				}),
			).toEqual({ supported: true });
		});
	});
});

describe('nearestDeliverableMode — the load-time clamp target', () => {
	// The migration case this exists for: a fleet device carrying a persisted
	// 1080p60 that the H.264 ladder cannot deliver.
	test('Osmo 1080p60 on H.264 clamps DOWN to 1080p30, not up and not sideways', () => {
		expect(
			nearestDeliverableMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '1080p',
				framerate: 60,
			}),
		).toEqual({ resolution: '1080p', framerate: 30 });
	});

	test('the clamp target is always a pairing the device really enumerated', () => {
		const clamped = nearestDeliverableMode({
			modes: OSMO_MODES,
			kind: 'uvc_h264',
			resolution: '2160p',
			framerate: 60,
		});
		expect(clamped).toBeDefined();
		expect(
			evaluateDeviceMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: clamped?.resolution,
				framerate: clamped?.framerate,
			}),
		).toEqual({ supported: true });
	});

	// Clamping UP would hand the operator a mode they never chose.
	test('prefers the highest rung AT OR BELOW the request', () => {
		expect(
			nearestDeliverableMode({
				modes: OSMO_MODES,
				kind: 'uvc_h264',
				resolution: '1440p',
				framerate: 30,
			}),
		).toEqual({ resolution: '1080p', framerate: 30 });
	});

	test('steps UP only when nothing at or below the request exists', () => {
		// A real enumerated MENU (two distinct rates ⇒ not a single-signal ceiling)
		// whose H.264 ladder offers nothing below 1080p. A UVC negotiation has no
		// scaler in front of it, so there is no lower target to step down to.
		const only1080 = [mode(1920, 1080, [30], H264), mode(1920, 1080, [60], MJPEG)];
		expect(
			nearestDeliverableMode({
				modes: only1080,
				kind: 'uvc_h264',
				resolution: '480p',
				framerate: 25,
			}),
		).toEqual({ resolution: '1080p', framerate: 30 });
	});

	test('a single-mode source clamps to its ceiling, keeping an in-range axis', () => {
		const hdmi = [mode(1920, 1080, [59.94])];
		expect(
			nearestDeliverableMode({ modes: hdmi, kind: 'hdmi', resolution: '2160p', framerate: 30 }),
		).toEqual({ resolution: '1080p', framerate: 30 });
		expect(
			nearestDeliverableMode({ modes: hdmi, kind: 'hdmi', resolution: '720p', framerate: 60 }),
		).toEqual({ resolution: '720p', framerate: 59.94 });
	});

	// Nothing truthful to clamp TO ⇒ the caller must leave the config alone.
	test('a source with no usable ladder yields NO clamp target', () => {
		expect(
			nearestDeliverableMode({ modes: [], resolution: '1080p', framerate: 60 }),
		).toBeUndefined();
		expect(
			nearestDeliverableMode({ modes: undefined, resolution: '1080p', framerate: 60 }),
		).toBeUndefined();
		expect(
			nearestDeliverableMode({ modes: [mode(64, 48, [7])], resolution: '1080p', framerate: 60 }),
		).toBeUndefined();
	});
});
