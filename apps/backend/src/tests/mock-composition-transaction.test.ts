import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	CerastreamRpcError,
	type CompositionConfig,
	changeConfigResultSchema,
	type StartParams,
} from "@ceralive/cerastream";
import {
	getMockState,
	getStreamingStats,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	changeMockComposition,
	setMockDeviceAttached,
	startMockStreaming,
	stopMockStreaming,
} from "../mocks/providers/streaming.ts";
import { forcedLegacy } from "./helpers/forced-legacy.ts";

const savedMode = process.env.MOCK_MODE;
const composition: CompositionConfig = {
	secondary_input_id: "hdmi",
	layout: "pip-top-right",
};
const cause =
	"invalid params: video_passthrough=force cannot be combined with composition";
const change = (value = composition) =>
	changeConfigResultSchema.parse(changeMockComposition(value));
beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});
afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

function refusal(action: () => unknown) {
	try {
		action();
	} catch (error) {
		if (!(error instanceof CerastreamRpcError)) throw error;
		return { code: error.code, message: error.message, data: error.data };
	}
	throw new Error("Expected native admission refusal");
}

function confirmed(primary = "usb", secondary = "usb2"): StartParams {
	const good = {
		...forcedLegacy,
		input_id: primary,
		video_passthrough: "off",
		composition: { ...composition, secondary_input_id: secondary },
	} satisfies StartParams;
	startMockStreaming({ ...good, composition: undefined });
	changeConfigResultSchema.parse(changeMockComposition(good.composition));
	stopMockStreaming();
	startMockStreaming(forcedLegacy);
	return good;
}

test("Start retains its post-selection force RPC refusal", () => {
	expect(
		refusal(() => startMockStreaming({ ...forcedLegacy, composition })),
	).toEqual({
		code: -32602,
		message: cause,
		data: { code: "cerastream.params.invalid" },
	});
	expect(getMockState().engineStart).toBeNull();
});

test("an unproven forced legacy rebuild returns rollback_failed with no_known_good and goes idle", () => {
	startMockStreaming(forcedLegacy);
	expect(change()).toEqual({
		attempt_id: "cc-1",
		phase: "rollback_failed",
		state: "idle",
		reason: `${cause}; no_known_good`,
	});
	expect(getMockState().engineStart).toBeNull();
	expect(getMockState().engineCompositionPrimaryInputId).toBeNull();
	expect(getStreamingStats().isActive).toBe(false);
});

test("a successful legacy rebuild returns applied without a failure reason", () => {
	startMockStreaming({ ...forcedLegacy, video_passthrough: "off" });
	expect(change()).toEqual({
		attempt_id: "cc-1",
		phase: "applied",
		state: "streaming",
	});
	expect(getMockState().engineStart).toEqual({
		...forcedLegacy,
		video_passthrough: "off",
		composition,
	});
});

test("a forced rebuild returns reverted and restores the confirmed target rather than the requested composition", () => {
	const good = confirmed();
	expect(change()).toEqual({
		attempt_id: "cc-2",
		phase: "reverted",
		state: "streaming",
		reason: cause,
	});
	expect(getMockState().engineStart).toEqual(good);
	expect(getMockState().engineCompositionPrimaryInputId).toBe("usb");
	expect(getStreamingStats().isActive).toBe(true);
});

for (const row of [
	{
		name: "missing confirmed secondary",
		primary: "usb",
		secondary: "usb2",
		reason:
			"invalid params: secondary-unavailable: capture input 'usb2' is not available",
	},
	{
		name: "missing confirmed primary",
		primary: "usb2",
		secondary: "hdmi",
		reason: "device not found: usb2",
	},
]) {
	test(`rollback failure: ${row.name} is returned as a transaction reason and settles idle`, () => {
		confirmed(row.primary, row.secondary);
		setMockDeviceAttached("usb2", false);
		expect(change()).toEqual({
			attempt_id: "cc-2",
			phase: "rollback_failed",
			state: "idle",
			reason: `${cause}; rollback: ${row.reason}`,
		});
		expect(getMockState().engineStart).toBeNull();
		expect(getStreamingStats().isActive).toBe(false);
	});
}

test("a failed restore keeps the process-lifetime confirmed target for a later transaction", () => {
	const good = confirmed();
	setMockDeviceAttached("usb2", false);
	expect(change().phase).toBe("rollback_failed");
	setMockDeviceAttached("usb2", true);
	startMockStreaming(forcedLegacy);
	expect(change()).toEqual({
		attempt_id: "cc-3",
		phase: "reverted",
		state: "streaming",
		reason: cause,
	});
	expect(getMockState().engineStart).toEqual(good);
});

test("an in-place composition edit does not replace a previously confirmed rebuild target", () => {
	const good = {
		...forcedLegacy,
		video_passthrough: "off" as const,
		composition: { ...composition, secondary_input_id: "usb2" },
	};
	startMockStreaming({ ...good, composition: undefined });
	change(good.composition);
	expect(change()).toEqual({
		attempt_id: "cc-2",
		phase: "applied",
		state: "streaming",
	});
	stopMockStreaming();
	startMockStreaming(forcedLegacy);
	expect(change()).toEqual({
		attempt_id: "cc-3",
		phase: "reverted",
		state: "streaming",
		reason: cause,
	});
	expect(getMockState().engineStart).toEqual(good);
});

test("neither plain Start nor an in-place edit invents a proven rollback target", () => {
	startMockStreaming({
		...forcedLegacy,
		video_passthrough: "off",
		composition,
	});
	change({ ...composition, secondary_input_id: "usb2" });
	stopMockStreaming();
	startMockStreaming(forcedLegacy);
	expect(change()).toEqual({
		attempt_id: "cc-2",
		phase: "rollback_failed",
		state: "idle",
		reason: `${cause}; no_known_good`,
	});
});

for (const row of [
	{
		name: "blank secondary before alpha",
		value: { ...composition, secondary_input_id: "", alpha: -1 },
		message:
			"invalid params: secondary-unavailable: capture input '' is not available",
		capture: "",
	},
	{
		name: "alpha before unknown secondary",
		value: { ...composition, secondary_input_id: "missing", alpha: -1 },
		message:
			"invalid params: composition alpha must be finite and between 0 and 1",
	},
	{
		name: "unknown secondary before unknown primary",
		value: { ...composition, secondary_input_id: "missing" },
		detach: "usb",
		message:
			"invalid params: secondary-unavailable: capture input 'missing' is not available",
		capture: "missing",
	},
	{
		name: "same primary before force rebuild",
		value: { ...composition, secondary_input_id: "usb" },
		message:
			"invalid params: secondary-unavailable: capture input 'usb' is not available",
		capture: "usb",
	},
	{
		name: "missing primary before force rebuild",
		value: composition,
		detach: "usb",
		message: "device not found: usb",
		code: -32003,
	},
]) {
	test(`live preflight ${row.name} outranks rebuild failure and rollback eligibility`, () => {
		startMockStreaming(forcedLegacy);
		if (row.detach) setMockDeviceAttached(row.detach, false);
		const before = structuredClone(getMockState().engineStart);
		expect(refusal(() => change(row.value))).toEqual({
			code: row.code ?? -32602,
			message: row.message,
			data: {
				code:
					row.code === -32003
						? "cerastream.device.not_found"
						: "cerastream.params.invalid",
				...(row.capture === undefined
					? {}
					: {
							capture_causes: [
								{ device: row.capture, cause: "secondary-unavailable" },
							],
						}),
			},
		});
		expect(getMockState().engineStart).toEqual(before);
		expect(getStreamingStats().isActive).toBe(true);
	});
}

test("preflight failure consumes its attempt id but preserves the confirmed rollback target", () => {
	const good = confirmed();
	refusal(() => change({ ...composition, alpha: -1 }));
	expect(change()).toEqual({
		attempt_id: "cc-3",
		phase: "reverted",
		state: "streaming",
		reason: cause,
	});
	expect(getMockState().engineStart).toEqual(good);
});

test("inactive admission precedes invalid composition and does not claim an attempt", () => {
	expect(refusal(() => change({ ...composition, alpha: -1 }))).toEqual({
		code: -32001,
		message: "no active stream",
		data: { code: "cerastream.state.not_streaming" },
	});
	startMockStreaming(forcedLegacy);
	expect(change().attempt_id).toBe("cc-1");
});

test("a new mock process forgets confirmed targets and restarts the transaction counter", () => {
	confirmed();
	stopMockService();
	initMockService("caps-full");
	startMockStreaming(forcedLegacy);
	expect(change()).toEqual({
		attempt_id: "cc-1",
		phase: "rollback_failed",
		state: "idle",
		reason: `${cause}; no_known_good`,
	});
});
