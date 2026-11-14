import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	type CaptureCauseEntry,
	CerastreamRpcError,
	type CompositionConfig,
	type CompositionRect,
	type StartParams,
} from "@ceralive/cerastream";
import {
	getMockState,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	changeMockComposition,
	startMockStreaming,
} from "../mocks/providers/streaming.ts";

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
const custom = (rect: CompositionRect): CompositionConfig => ({
	...preset,
	layout: "custom",
	rect,
});

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});

afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

function refusal(action: () => void): CerastreamRpcError {
	try {
		action();
	} catch (error) {
		if (error instanceof CerastreamRpcError) return error;
		throw error;
	}
	throw new Error("expected a native RPC refusal");
}

const validRectangles = [
	["minimum at origin", { x: 0, y: 0, width: 0.125, height: 0.125 }],
	[
		"minimum at far corner",
		{ x: 0.875, y: 0.875, width: 0.125, height: 0.125 },
	],
	["right edge", { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }],
	["bottom edge", { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }],
	["full frame", { x: 0, y: 0, width: 1, height: 1 }],
] satisfies [string, CompositionRect][];

const epsilon = Number.EPSILON;
const invalidRectangles = [
	["x below zero", { x: -epsilon, y: 0.25, width: 0.5, height: 0.5 }],
	["y below zero", { x: 0.25, y: -epsilon, width: 0.5, height: 0.5 }],
	[
		"x beyond right edge",
		{ x: 0.875 + epsilon, y: 0.25, width: 0.125, height: 0.5 },
	],
	[
		"y beyond bottom edge",
		{ x: 0.25, y: 0.875 + epsilon, width: 0.5, height: 0.125 },
	],
	[
		"width below minimum",
		{ x: 0.25, y: 0.25, width: 0.125 - epsilon, height: 0.5 },
	],
	[
		"height below minimum",
		{ x: 0.25, y: 0.25, width: 0.5, height: 0.125 - epsilon },
	],
	["width above full frame", { x: 0, y: 0, width: 1 + epsilon, height: 1 }],
	["height above full frame", { x: 0, y: 0, width: 1, height: 1 + epsilon }],
	["nonfinite x", { x: Number.NaN, y: 0.25, width: 0.5, height: 0.5 }],
	["nonfinite y", { x: 0.25, y: Number.NaN, width: 0.5, height: 0.5 }],
	["nonfinite width", { x: 0.25, y: 0.25, width: Number.NaN, height: 0.5 }],
	["nonfinite height", { x: 0.25, y: 0.25, width: 0.5, height: Number.NaN }],
] satisfies [string, CompositionRect][];

for (const path of ["start", "live"] as const) {
	const prepare = () => {
		if (path === "live") startMockStreaming({ ...base, composition: preset });
		return (composition: CompositionConfig) => {
			if (path === "start") startMockStreaming({ ...base, composition });
			else changeMockComposition(composition);
		};
	};

	test.each(validRectangles)(`${path} accepts rectangle %s`, (_name, rect) => {
		const apply = prepare();
		apply(custom(rect));
		expect(getMockState().engineStart?.composition?.rect).toEqual(rect);
	});

	test.each(invalidRectangles)(
		`${path} refuses rectangle %s`,
		(_name, rect) => {
			const apply = prepare();
			const previous = structuredClone(getMockState().engineStart);
			const error = refusal(() => apply(custom(rect)));
			expect(error.message).toContain("composition-rect-range");
			expect(error.code).toBe(-32602);
			expect(error.dataCode).toBe("cerastream.params.invalid");
			expect(error.captureCauses()).toEqual([]);
			expect(getMockState().engineStart).toEqual(previous);
		},
	);

	test(`${path} unsupported custom layout carries the complete native composition refusal`, () => {
		initMockService("multi-modem-wifi");
		if (path === "live") startMockStreaming(base);
		const previous = structuredClone(getMockState().engineStart);
		const composition = custom({ x: 0, y: 0, width: 1, height: 1 });
		const error = refusal(() => {
			if (path === "start") startMockStreaming({ ...base, composition });
			else changeMockComposition(composition);
		});
		const capture_causes = [
			{ device: "composition", cause: "composition-unsupported" },
		] satisfies CaptureCauseEntry[];
		expect({
			code: error.code,
			message: error.message,
			dataCode: error.dataCode,
			requestId: error.requestId,
			data: error.data,
			captureCauses: error.captureCauses(),
		}).toEqual({
			code: -32602,
			message:
				"invalid params: composition-unsupported: rgacompositor did not pass its READY backend trial",
			dataCode: "cerastream.params.invalid",
			requestId: null,
			data: { code: "cerastream.params.invalid", capture_causes },
			captureCauses: capture_causes,
		});
		expect(getMockState().engineStart).toEqual(previous);
	});

	test(`${path} malformed geometry is refused before unavailable composition`, () => {
		initMockService("multi-modem-wifi");
		if (path === "live") startMockStreaming(base);
		const composition = custom({ x: 0, y: 0, width: 1 + epsilon, height: 1 });
		const error = refusal(() => {
			if (path === "start") startMockStreaming({ ...base, composition });
			else changeMockComposition(composition);
		});
		expect(error.message).toContain("composition-rect-range");
		expect(error.captureCauses()).toEqual([]);
	});
}
