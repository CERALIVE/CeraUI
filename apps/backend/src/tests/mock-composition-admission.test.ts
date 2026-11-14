import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	CerastreamRpcError,
	type ChangeConfigResult,
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
} from "../mocks/providers/streaming.ts";
import { forcedLegacy } from "./helpers/forced-legacy.ts";

const savedMode = process.env.MOCK_MODE;
const base: StartParams = {
	pipeline: "hdmi",
	input_id: "hdmi",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 120 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "adaptive" },
};
const preset: CompositionConfig = {
	secondary_input_id: "usb",
	layout: "pip-top-right",
};
const paramsInvalid = (message: string) => ({
	code: -32602,
	message: `invalid params: ${message}`,
	data: { code: "cerastream.params.invalid" },
	captureCauses: [],
});
const secondaryUnavailable = (id: string): ReturnType<typeof refusal> => ({
	code: -32602,
	message: `invalid params: secondary-unavailable: capture input '${id}' is not available`,
	data: {
		code: "cerastream.params.invalid",
		capture_causes: [{ device: id, cause: "secondary-unavailable" }],
	},
	captureCauses: [{ device: id, cause: "secondary-unavailable" }],
});
const missingPrimary = {
	code: -32003,
	message: "device not found: hdmi",
	data: { code: "cerastream.device.not_found" },
	captureCauses: [],
};
const alphaError = paramsInvalid(
	"composition alpha must be finite and between 0 and 1",
);
const forceError = paramsInvalid(
	"video_passthrough=force cannot be combined with composition",
);

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});
afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

function refusal(action: () => void) {
	try {
		action();
	} catch (error) {
		if (!(error instanceof CerastreamRpcError)) throw error;
		return {
			code: error.code,
			message: error.message,
			data: error.data,
			captureCauses: error.captureCauses(),
		};
	}
	throw new Error("Expected native composition refusal");
}

const rows: Array<{
	name: string;
	composition: CompositionConfig;
	expected: ReturnType<typeof refusal>;
	detach?: string[];
	unavailable?: boolean;
	autoPrimary?: boolean;
	legacy?: boolean;
	force?: boolean;
	liveTransaction?: ChangeConfigResult;
	primary?: string;
}> = [
	{
		name: "geometry before unavailable compositor and blank secondary and alpha",
		composition: {
			...preset,
			layout: "custom",
			rect: { x: 0, y: 0, width: 2, height: 1 },
			secondary_input_id: "",
			alpha: -1,
		},
		unavailable: true,
		detach: ["hdmi"],
		expected: paramsInvalid(
			"composition-rect-range: rect must fit the frame with sides at least 0.125",
		),
	},
	{
		name: "availability before blank secondary and alpha and primary lookup",
		composition: { ...preset, secondary_input_id: "", alpha: -1 },
		unavailable: true,
		detach: ["hdmi"],
		expected: {
			...paramsInvalid(
				"composition-unsupported: rgacompositor did not pass its READY backend trial",
			),
			data: {
				code: "cerastream.params.invalid",
				capture_causes: [
					{ device: "composition", cause: "composition-unsupported" },
				],
			},
			captureCauses: [
				{ device: "composition", cause: "composition-unsupported" },
			],
		},
	},
	...["", " ", "\t\n", "\u0085"].map((id) => ({
		name: `blank secondary ${JSON.stringify(id)} before alpha and primary lookup`,
		composition: { ...preset, secondary_input_id: id, alpha: -1 },
		detach: ["hdmi"],
		expected: secondaryUnavailable(id),
	})),
	...[
		-Number.EPSILON,
		1 + Number.EPSILON,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	].map((alpha) => ({
		name: `alpha ${alpha} before secondary and primary lookup`,
		composition: { ...preset, secondary_input_id: "missing-secondary", alpha },
		detach: ["hdmi"],
		expected: alphaError,
	})),
	{
		name: "alpha before unknown BOM secondary which is not Rust whitespace",
		composition: { ...preset, secondary_input_id: "\ufeff", alpha: -1 },
		expected: alphaError,
	},
	{
		name: "alpha before same-primary refusal",
		composition: { ...preset, secondary_input_id: "hdmi", alpha: -1 },
		expected: alphaError,
	},
	{
		name: "alpha before missing automatic primary",
		composition: { ...preset, alpha: -1 },
		autoPrimary: true,
		legacy: true,
		detach: ["hdmi", "usb2"],
		expected: alphaError,
	},
	...["missing-secondary", "audio_rode_ai_micro"].map((id) => ({
		name: `secondary ${id} before missing primary`,
		composition: { ...preset, secondary_input_id: id },
		detach: ["hdmi"],
		expected: secondaryUnavailable(id),
	})),
	{
		name: "secondary cannot equal the primary",
		composition: { ...preset, secondary_input_id: "hdmi" },
		expected: secondaryUnavailable("hdmi"),
	},
	{
		name: "known secondary before explicit missing primary",
		composition: preset,
		detach: ["hdmi"],
		expected: missingPrimary,
	},
	{
		name: "audio identity cannot be a primary capture",
		composition: preset,
		primary: "audio_rode_ai_micro",
		expected: {
			code: -32003,
			message: "device not found: audio_rode_ai_micro",
			data: { code: "cerastream.device.not_found" },
			captureCauses: [],
		},
		legacy: true,
	},
	{
		name: "automatic primary needs another video capture",
		composition: preset,
		autoPrimary: true,
		legacy: true,
		detach: ["hdmi", "usb2"],
		expected: secondaryUnavailable("usb"),
	},
	{
		name: "blank secondary before forced passthrough",
		composition: { ...preset, secondary_input_id: "" },
		force: true,
		legacy: true,
		expected: secondaryUnavailable(""),
	},
	{
		name: "alpha before forced passthrough",
		composition: { ...preset, alpha: -1 },
		force: true,
		legacy: true,
		expected: alphaError,
	},
	{
		name: "secondary lookup before forced passthrough",
		composition: { ...preset, secondary_input_id: "missing-secondary" },
		force: true,
		legacy: true,
		expected: secondaryUnavailable("missing-secondary"),
	},
	{
		name: "same-primary refusal before forced passthrough",
		composition: { ...preset, secondary_input_id: "hdmi" },
		force: true,
		legacy: true,
		expected: secondaryUnavailable("hdmi"),
	},
	{
		name: "primary lookup before forced passthrough",
		composition: preset,
		force: true,
		legacy: true,
		detach: ["hdmi"],
		expected: missingPrimary,
	},
	{
		name: "composition refuses forced passthrough after device selection",
		composition: preset,
		force: true,
		legacy: true,
		expected: forceError,
		liveTransaction: {
			attempt_id: "cc-1",
			phase: "rollback_failed",
			state: "idle",
			reason:
				"invalid params: video_passthrough=force cannot be combined with composition; no_known_good",
		},
	},
];

for (const path of ["start", "live"] as const) {
	for (const row of rows) {
		test(`${path} composition admission: ${row.name}`, () => {
			if (row.unavailable) initMockService("multi-modem-wifi");
			if (path === "live" && row.liveTransaction) {
				startMockStreaming(forcedLegacy);
				expect(
					changeConfigResultSchema.parse(
						changeMockComposition({
							...row.composition,
							secondary_input_id: "hdmi",
						}),
					),
				).toEqual(row.liveTransaction);
				expect(getMockState().engineStart).toBeNull();
				expect(getStreamingStats().isActive).toBe(false);
				return;
			}
			const request: StartParams = {
				...base,
				input_id: row.autoPrimary ? undefined : (row.primary ?? base.input_id),
				...(row.force ? { video_passthrough: "force" } : {}),
			};
			if (path === "live")
				startMockStreaming({
					...request,
					...(!row.unavailable && !row.legacy ? { composition: preset } : {}),
				});
			for (const id of row.detach ?? []) setMockDeviceAttached(id, false);
			const previous = structuredClone(getMockState().engineStart);
			const active = getStreamingStats().isActive;
			expect(
				refusal(() =>
					path === "start"
						? startMockStreaming({ ...request, composition: row.composition })
						: changeMockComposition(row.composition),
				),
			).toEqual(row.expected);
			expect(getMockState().engineStart).toEqual(previous);
			expect(getStreamingStats().isActive).toBe(active);
		});
	}
	for (const alpha of [undefined, 0, 1]) {
		test(`${path} composition accepts alpha ${alpha} and distinct capture identities`, () => {
			if (path === "live") startMockStreaming({ ...base, composition: preset });
			const composition = { ...preset, alpha };
			if (path === "start") startMockStreaming({ ...base, composition });
			else changeMockComposition(composition);
			expect(getMockState().engineStart?.composition).toEqual(composition);
		});
	}
}

test("live composition retains the automatically selected primary when changing secondary", () => {
	startMockStreaming({ ...base, input_id: undefined, composition: preset });
	const previous = structuredClone(getMockState().engineStart);
	expect(
		refusal(() =>
			changeMockComposition({ ...preset, secondary_input_id: "hdmi" }),
		),
	).toEqual(secondaryUnavailable("hdmi"));
	expect(getMockState().engineStart).toEqual(previous);
});

test("live composition refuses its lost automatic primary instead of selecting another", () => {
	startMockStreaming({ ...base, input_id: undefined, composition: preset });
	setMockDeviceAttached("hdmi", false);
	const previous = structuredClone(getMockState().engineStart);
	expect(
		refusal(() =>
			changeMockComposition({ ...preset, secondary_input_id: "usb2" }),
		),
	).toEqual(missingPrimary);
	expect(getMockState().engineStart).toEqual(previous);
});
