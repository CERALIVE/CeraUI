/*
 * The "No HDMI signal detected" RAISE must be scoped like its RECOVERY.
 *
 * `clearHdmiSignalErrorOnRecovery` has always required a `kind === "hdmi"`
 * capture row reporting an engine-authored `signal: "present"`. The raise had no
 * equivalent: it fired on the kernel line alone, gated only on the board being an
 * rk3588. Measured on `192.168.78.131` (2026-07-30): a `streaming.start` attempt
 * probes EVERY capture input, so it opens `/dev/video0` in passing, and on a board
 * whose HDMI-RX carries no cable the kernel prints `hdmirx-controller: Err, timing
 * is invalid` — raising "No HDMI signal detected" at an operator streaming a USB
 * camera who had asked nothing about HDMI.
 *
 * The gate is SUPPRESSION-ONLY: it may withhold a raise only when the selection is
 * PROVEN to be something other than an HDMI input. Every test below that asserts a
 * raise is a negative control for that rule.
 *
 * The EMI/cable advisory shares the `hdmi_error` channel and keeps its own
 * trigger (it is not subject to the selection gate above), but its raise is no
 * longer unconditional — see "the EMI/cable advisory's dedup guard" below.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import {
	EMI_ADVISORY_MSG,
	HDMI_ERROR_NOTIFICATION,
	HDMI_NO_SIGNAL_MSG,
	type HdmiSelectionObservation,
	provesSelectionIsNotHdmi,
} from "../modules/system/hdmi-signal-notification.ts";
import {
	type HdmiDmesgDeps,
	handleRk3588HdmiDmesg,
} from "../modules/system/sensors.ts";

const NO_SIGNAL_LINE =
	"[  812.443001] hdmirx-controller: Err, timing is invalid\n";
const EMI_LINE =
	"[  812.443001] hdmirx_wait_lock_and_get_timing signal not lock\n";
const AUDIO_UNDERFLOW_LINE =
	"[  812.443001] hdmirx_delayed_work_audio: audio underflow\n";

interface RaisedNotification {
	name: string;
	msg: string;
}

function harness(
	noSignalRaiseAllowed: boolean,
	standing?: { msg: string },
): { deps: HdmiDmesgDeps; raised: RaisedNotification[] } {
	const raised: RaisedNotification[] = [];
	return {
		raised,
		deps: {
			peek: () => standing,
			raise: (name, _type, msg) => {
				raised.push({ name, msg });
			},
			noSignalRaiseAllowed: () => noSignalRaiseAllowed,
		},
	};
}

// ─── Fixtures: the two rows the board actually reports ───────────────────────

const USB_CAMERA: HdmiSelectionObservation = {
	id: "/dev/video1",
	origin: "capture",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
};

const HDMI_INPUT: HdmiSelectionObservation = {
	id: "/dev/video0",
	origin: "capture",
	pipelineId: "hdmi",
	kind: "hdmi",
};

const COARSE_HDMI: HdmiSelectionObservation = {
	id: "hdmi",
	origin: "coarse",
	pipelineId: "hdmi",
};

const COARSE_USB: HdmiSelectionObservation = {
	id: "usb_mjpeg",
	origin: "coarse",
	pipelineId: "usb_mjpeg",
};

function remembered(id: string, kind: string): LastSeenDevice {
	return {
		id,
		displayName: "DJIPocket3: OsmoPocket3",
		kind: kind as LastSeenDevice["kind"],
		pipelineId: "libuvch264",
		devicePath: id,
	};
}

describe("provesSelectionIsNotHdmi — suppression needs POSITIVE evidence", () => {
	test("a selected USB camera proves the HDMI claim is not addressed to anyone", () => {
		expect(
			provesSelectionIsNotHdmi("/dev/video1", [USB_CAMERA, HDMI_INPUT]),
		).toBe(true);
	});

	test("a selected HDMI input proves nothing of the sort", () => {
		expect(
			provesSelectionIsNotHdmi("/dev/video0", [USB_CAMERA, HDMI_INPUT]),
		).toBe(false);
	});

	test("a coarse selection is decided by its source id, both ways", () => {
		expect(provesSelectionIsNotHdmi("usb_mjpeg", [COARSE_USB])).toBe(true);
		expect(provesSelectionIsNotHdmi("hdmi", [COARSE_HDMI])).toBe(false);
	});

	test("no selection at all is not evidence", () => {
		expect(provesSelectionIsNotHdmi(undefined, [USB_CAMERA])).toBe(false);
		expect(provesSelectionIsNotHdmi("", [USB_CAMERA])).toBe(false);
	});

	test("a selection nothing can resolve is not evidence", () => {
		expect(provesSelectionIsNotHdmi("/dev/video7", [USB_CAMERA])).toBe(false);
	});

	test("a renumbered camera is still recognised through previousIds", () => {
		const successor: HdmiSelectionObservation = {
			...USB_CAMERA,
			id: "/dev/video2",
			previousIds: ["/dev/video1"],
		};
		expect(provesSelectionIsNotHdmi("/dev/video1", [successor])).toBe(true);
	});

	test("a live row missing mid-sweep falls back to the persisted kind", () => {
		expect(
			provesSelectionIsNotHdmi(
				"/dev/video1",
				[HDMI_INPUT],
				[remembered("/dev/video1", "uvc_h264")],
			),
		).toBe(true);
		expect(
			provesSelectionIsNotHdmi(
				"/dev/video0",
				[],
				[remembered("/dev/video0", "hdmi")],
			),
		).toBe(false);
	});

	test("the LIVE row outranks a stale persisted snapshot", () => {
		expect(
			provesSelectionIsNotHdmi(
				"/dev/video0",
				[HDMI_INPUT],
				[remembered("/dev/video0", "uvc_h264")],
			),
		).toBe(false);
	});
});

describe("handleRk3588HdmiDmesg — the raise it is allowed to make", () => {
	let h: ReturnType<typeof harness>;

	describe("the stream-start sweep incidentally probing /dev/video0", () => {
		beforeEach(() => {
			h = harness(false);
		});

		test("raises NOTHING", () => {
			handleRk3588HdmiDmesg(NO_SIGNAL_LINE, h.deps);
			expect(h.raised).toEqual([]);
		});

		test("does not disturb the EMI/cable advisory, whose own trigger is unchanged", () => {
			handleRk3588HdmiDmesg(EMI_LINE, h.deps);
			expect(h.raised).toHaveLength(1);
			expect(h.raised[0]?.name).toBe(HDMI_ERROR_NOTIFICATION);
			expect(h.raised[0]?.msg).toBe(EMI_ADVISORY_MSG);
		});
	});

	/*
	 * DELIBERATE POLICY CHANGE — the test above previously read "…which stays
	 * ungated" and was the whole of the advisory's coverage, because its raise
	 * was unconditional.
	 *
	 * Its TRIGGER is still unchanged (the same two kernel lines, still outside
	 * `noSignalRaiseAllowed`'s selection gate — that is what "ungated" meant and
	 * still means). What is new is a DEDUP guard around the raise itself: the
	 * kernel prints those lines repeatedly while a link merely settles, and an
	 * unconditional raise re-fired a fresh toast on every one of them. The
	 * sibling no-signal raise has always carried this kind of guard; the advisory
	 * had none, so it could also overwrite a standing no-signal notification on
	 * the channel the two share.
	 */
	describe("the EMI/cable advisory's dedup guard", () => {
		test("raises when the channel is free", () => {
			const scoped = harness(true);
			handleRk3588HdmiDmesg(EMI_LINE, scoped.deps);
			expect(scoped.raised).toEqual([
				{ name: HDMI_ERROR_NOTIFICATION, msg: EMI_ADVISORY_MSG },
			]);
		});

		test("does NOT re-fire over its own standing advisory", () => {
			const scoped = harness(true, { msg: EMI_ADVISORY_MSG });
			handleRk3588HdmiDmesg(EMI_LINE, scoped.deps);
			expect(scoped.raised).toEqual([]);
		});

		test("does NOT clobber a standing no-signal notification", () => {
			const scoped = harness(true, { msg: HDMI_NO_SIGNAL_MSG });
			handleRk3588HdmiDmesg(EMI_LINE, scoped.deps);
			expect(scoped.raised).toEqual([]);
		});

		test("a settling link printing the line repeatedly costs exactly one raise", () => {
			let standing: { msg: string } | undefined;
			const raised: RaisedNotification[] = [];
			const deps: HdmiDmesgDeps = {
				peek: () => standing,
				raise: (name, _type, msg) => {
					raised.push({ name, msg });
					standing = { msg };
				},
				noSignalRaiseAllowed: () => true,
			};

			for (let i = 0; i < 5; i++) handleRk3588HdmiDmesg(EMI_LINE, deps);

			expect(raised).toEqual([
				{ name: HDMI_ERROR_NOTIFICATION, msg: EMI_ADVISORY_MSG },
			]);
		});

		test("the audio-underflow line is still a trigger, under the same guard", () => {
			const free = harness(true);
			handleRk3588HdmiDmesg(AUDIO_UNDERFLOW_LINE, free.deps);
			expect(free.raised).toHaveLength(1);

			const occupied = harness(true, { msg: EMI_ADVISORY_MSG });
			handleRk3588HdmiDmesg(AUDIO_UNDERFLOW_LINE, occupied.deps);
			expect(occupied.raised).toEqual([]);
		});
	});

	// ─── NEGATIVE CONTROL: a genuine no-signal must still reach the operator ──

	describe("a genuinely selected HDMI input with no cable", () => {
		beforeEach(() => {
			h = harness(true);
		});

		test("raises the no-signal notification, unchanged", () => {
			handleRk3588HdmiDmesg(NO_SIGNAL_LINE, h.deps);
			expect(h.raised).toEqual([
				{ name: HDMI_ERROR_NOTIFICATION, msg: HDMI_NO_SIGNAL_MSG },
			]);
		});

		test("still refuses to overwrite a standing EMI advisory", () => {
			const scoped = harness(true, { msg: "HDMI signal issues detected. …" });
			handleRk3588HdmiDmesg(NO_SIGNAL_LINE, scoped.deps);
			expect(scoped.raised).toEqual([]);
		});

		test("re-raises over its own standing no-signal notification", () => {
			const scoped = harness(true, { msg: HDMI_NO_SIGNAL_MSG });
			handleRk3588HdmiDmesg(NO_SIGNAL_LINE, scoped.deps);
			expect(scoped.raised).toHaveLength(1);
			expect(scoped.raised[0]?.msg).toBe(HDMI_NO_SIGNAL_MSG);
		});
	});

	test("an unrelated kernel line raises nothing either way", () => {
		const scoped = harness(true);
		handleRk3588HdmiDmesg(
			"[  99.0] usb 5-1: Found UVC 1.00 device\n",
			scoped.deps,
		);
		expect(scoped.raised).toEqual([]);
	});
});
