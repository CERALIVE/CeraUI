/*
 * Todo 6 — device-wide `sources_visibility` config + `streaming.setSourceVisibility` RPC.
 *
 * Config-only row visibility for the VIRTUAL (test-pattern) origin — NOT a
 * service-level gate (no gateway/three-mirror predicate). The single mutation
 * path is the new `setSourceVisibility` RPC (never generic `streaming.setConfig`).
 * The backend NEVER drops a hidden row — it marks the virtual row `available:false`
 * with the existing `DISABLED_IN_SETTINGS_REASON` so the frontend owns fail-visible
 * rendering.
 *
 * Coverage:
 *   (a) runtimeConfigSchema: absent key defaults all-visible; round-trips the key.
 *   (b) buildSources marks the hidden virtual row; capture/coarse/network untouched.
 *   (c) the RPC persists (saveConfig) then rebroadcasts `sources` AND echoes `config`.
 *   (d) hidden-but-selected still EMITS the row (backend never drops rows).
 *   + single-mutation-path discipline: `setConfig` strips a `sources_visibility` field.
 *   + malformed (non-boolean) input rejected by Zod with a structured error.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { NetworkIngest } from "@ceraui/rpc/schemas";
import {
	setSourceVisibilityInputSchema,
	sourcesVisibilitySchema,
	streamingConfigInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	buildSources,
	getSourcesMessage,
	resolveSourceRouting,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { appRouter } from "../rpc/router.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const DISABLED_IN_SETTINGS_REASON = "live.education.reason.disabledInSettings";

type CapabilitySource = GetCapabilitiesResult["sources"][number];

function capSource(
	id: string,
	overrides: Partial<CapabilitySource> = {},
): CapabilitySource {
	return {
		id,
		supports_audio: overrides.supports_audio ?? false,
		supports_resolution_override:
			overrides.supports_resolution_override ?? true,
		supports_framerate_override: overrides.supports_framerate_override ?? true,
		default_resolution: overrides.default_resolution ?? "1080p",
		default_framerate: overrides.default_framerate ?? 30,
	};
}

const ACTIVE_INGEST: NetworkIngest = {
	rtmp: { service_active: true, url: "rtmp://10.0.0.5:1935/publish/live" },
	srt: { service_active: true, url: "srt://10.0.0.5:4001" },
};

// A representative caps set: a coarse (hdmi), a network (rtmp), and the virtual
// (test) source, so a marking test can prove ONLY the virtual row is affected.
function mixedCapSources(): CapabilitySource[] {
	return [capSource("hdmi"), capSource("rtmp"), capSource("test")];
}

// ─── (a) runtimeConfigSchema round-trip ───────────────────────────────────────

describe("sources_visibility — runtimeConfigSchema round-trip", () => {
	test("parses a config WITHOUT the key (all-visible default)", () => {
		const parsed = runtimeConfigSchema.parse({});
		expect(parsed.sources_visibility).toBeUndefined();

		// Absent visibility → the test-pattern row is visible (available:true).
		const sources = buildSources({
			sources: [capSource("test")],
			devices: [],
			networkIngest: { rtmp: null, srt: null },
			...(parsed.sources_visibility !== undefined
				? { sourcesVisibility: parsed.sources_visibility }
				: {}),
		});
		const test = sources.find((s) => s.id === "test");
		expect(test?.origin).toBe("virtual");
		expect(test?.available).toBe(true);
		expect(test?.unavailableReason).toBeUndefined();
	});

	test("round-trips { sources_visibility: { hide_test_pattern: true } }", () => {
		const parsed = runtimeConfigSchema.parse({
			sources_visibility: { hide_test_pattern: true },
		});
		expect(parsed.sources_visibility).toEqual({ hide_test_pattern: true });

		const reparsed = runtimeConfigSchema.parse(
			JSON.parse(JSON.stringify(parsed)),
		);
		expect(reparsed.sources_visibility).toEqual({ hide_test_pattern: true });
	});

	test("an empty sources_visibility object defaults hide_test_pattern to false", () => {
		const parsed = runtimeConfigSchema.parse({ sources_visibility: {} });
		expect(parsed.sources_visibility).toEqual({ hide_test_pattern: false });
	});
});

// ─── (b) buildSources marking ─────────────────────────────────────────────────

describe("buildSources — test-pattern visibility marking", () => {
	test("hide_test_pattern=true marks ONLY the virtual row available:false + disabledInSettings", () => {
		const sources = buildSources({
			sources: mixedCapSources(),
			devices: [],
			networkIngest: ACTIVE_INGEST,
			sourcesVisibility: { hide_test_pattern: true },
		});

		const test = sources.find((s) => s.id === "test");
		expect(test?.origin).toBe("virtual");
		expect(test?.available).toBe(false);
		expect(test?.unavailableReason).toBe(DISABLED_IN_SETTINGS_REASON);

		// The coarse + network rows are UNTOUCHED by a virtual-only hide.
		const hdmi = sources.find((s) => s.id === "hdmi");
		expect(hdmi?.origin).toBe("coarse");
		expect(hdmi?.available).toBe(true);
		expect(hdmi?.unavailableReason).toBeUndefined();

		const rtmp = sources.find((s) => s.id === "rtmp");
		expect(rtmp?.origin).toBe("network");
		expect(rtmp?.available).toBe(true);
		expect(rtmp?.unavailableReason).toBeUndefined();
	});

	test("hide_test_pattern=false leaves the virtual row visible (no reason)", () => {
		const sources = buildSources({
			sources: mixedCapSources(),
			devices: [],
			networkIngest: ACTIVE_INGEST,
			sourcesVisibility: { hide_test_pattern: false },
		});
		const test = sources.find((s) => s.id === "test");
		expect(test?.available).toBe(true);
		expect(test?.unavailableReason).toBeUndefined();
	});

	test("a capture row is untouched when the test pattern is hidden", () => {
		const sources = buildSources({
			sources: [capSource("hdmi"), capSource("test")],
			devices: [
				{
					input_id: "video0",
					device_path: "/dev/video0",
					display_name: "Magewell HDMI",
					media_class: "video",
					kind: "hdmi",
				},
			],
			networkIngest: { rtmp: null, srt: null },
			sourcesVisibility: { hide_test_pattern: true },
		});
		const capture = sources.find((s) => s.origin === "capture");
		expect(capture?.available).toBe(true);
		expect(capture?.unavailableReason).toBeUndefined();
		const test = sources.find((s) => s.id === "test");
		expect(test?.available).toBe(false);
	});

	// (d) hidden-but-selected still emits the row (backend NEVER drops rows).
	test("a hidden-but-selected test row is STILL emitted (never dropped) and still routes", () => {
		const sources = buildSources({
			sources: mixedCapSources(),
			devices: [],
			networkIngest: ACTIVE_INGEST,
			sourcesVisibility: { hide_test_pattern: true },
		});
		// The row is present even though it is hidden — the frontend owns
		// fail-visible rendering, the backend always emits.
		const test = sources.find((s) => s.id === "test");
		expect(test).toBeDefined();
		expect(test?.available).toBe(false);

		// The routing seam still resolves its id (a start/setConfig with
		// config.source='test' is not an unknown_source — visibility is not routing).
		const routed = resolveSourceRouting("test", sources);
		expect(routed.ok).toBe(true);
		if (routed.ok) {
			expect(routed.pipeline).toBe("test");
			expect(routed.selected_video_input).toBeUndefined();
		}
	});
});

// ─── single-mutation-path discipline + malformed input ────────────────────────

describe("sources_visibility — mutation-path discipline + validation", () => {
	test("streaming.setConfig STRIPS a sources_visibility field (single mutation path)", () => {
		const parsed = streamingConfigInputSchema.parse({
			max_br: 6000,
			sources_visibility: { hide_test_pattern: true },
		});
		// The generic setConfig input never carries the key — it is stripped, so a
		// setConfig({sources_visibility}) can never mutate visibility.
		expect("sources_visibility" in parsed).toBe(false);
		expect(parsed.max_br).toBe(6000);
	});

	test("setSourceVisibilityInputSchema rejects a non-boolean with a structured Zod error", () => {
		const result = setSourceVisibilityInputSchema.safeParse({
			hide_test_pattern: "yes",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.length).toBeGreaterThan(0);
			expect(result.error.issues[0]?.path).toEqual(["hide_test_pattern"]);
		}
	});

	test("setSourceVisibilityInputSchema requires the field (no default on the input)", () => {
		expect(setSourceVisibilityInputSchema.safeParse({}).success).toBe(false);
	});

	test("sourcesVisibilitySchema defaults hide_test_pattern to false", () => {
		expect(sourcesVisibilitySchema.parse({})).toEqual({
			hide_test_pattern: false,
		});
	});
});

// ─── (c) RPC persist + rebroadcast (config echo + sources) ─────────────────────

const CAPS_WITH_TEST: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		capSource("hdmi"),
		capSource("rtmp", { supports_resolution_override: false }),
		capSource("test"),
	],
};

function provide(snapshot: GetCapabilitiesResult) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: snapshot,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

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

/** Authed fake client recording every decoded broadcast frame. */
function makeRecordingClient(
	sink: Array<Record<string, unknown>>,
): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (msg: string) => {
			try {
				sink.push(JSON.parse(msg) as Record<string, unknown>);
			} catch {
				// non-JSON frame — irrelevant here
			}
		},
	} as unknown as AppWebSocket;
}

describe("streaming.setSourceVisibility RPC — persist + rebroadcast", () => {
	const savedMockMode = process.env.MOCK_MODE;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide(CAPS_WITH_TEST));
	});
	beforeEach(() => {
		delete (getConfig() as { sources_visibility?: unknown }).sources_visibility;
	});
	afterEach(() => {
		setStreamingState(false);
		updateStatus(false);
		delete (getConfig() as { sources_visibility?: unknown }).sources_visibility;
		resetMockState();
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("flips config, echoes config, and rebroadcasts the hidden sources row", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			const res = await call(
				appRouter.streaming.setSourceVisibility,
				{ hide_test_pattern: true },
				{ context: makeContext() },
			);
			expect(res).toEqual({
				success: true,
				applied: { hide_test_pattern: true },
			});

			// Persisted via the config singleton.
			expect(getConfig().sources_visibility).toEqual({
				hide_test_pattern: true,
			});

			// The `sources` snapshot (what broadcastSources sends) marks the row.
			const test = getSourcesMessage().sources.find((s) => s.id === "test");
			expect(test?.available).toBe(false);
			expect(test?.unavailableReason).toBe(DISABLED_IN_SETTINGS_REASON);

			// A `config` echo frame carrying sources_visibility was broadcast.
			const configFrame = sink.find((m) => "config" in m);
			expect(configFrame).toBeDefined();
			const echoed = (configFrame?.config as Record<string, unknown>)
				.sources_visibility;
			expect(echoed).toEqual({ hide_test_pattern: true });

			// A fresh `sources` frame was broadcast with the hidden virtual row.
			const sourcesFrame = sink.find((m) => "sources" in m);
			expect(sourcesFrame).toBeDefined();
			const broadcastSourcesList = (
				sourcesFrame?.sources as { sources: Array<Record<string, unknown>> }
			).sources;
			const broadcastTest = broadcastSourcesList.find((s) => s.id === "test");
			expect(broadcastTest?.available).toBe(false);
			expect(broadcastTest?.unavailableReason).toBe(
				DISABLED_IN_SETTINGS_REASON,
			);
		} finally {
			removeClient(client);
		}
	});

	test("re-enabling clears the hidden state and re-emits a visible row", async () => {
		await call(
			appRouter.streaming.setSourceVisibility,
			{ hide_test_pattern: true },
			{ context: makeContext() },
		);
		const res = await call(
			appRouter.streaming.setSourceVisibility,
			{ hide_test_pattern: false },
			{ context: makeContext() },
		);
		expect(res).toEqual({
			success: true,
			applied: { hide_test_pattern: false },
		});
		expect(getConfig().sources_visibility).toEqual({
			hide_test_pattern: false,
		});
		const test = getSourcesMessage().sources.find((s) => s.id === "test");
		expect(test?.available).toBe(true);
		expect(test?.unavailableReason).toBeUndefined();
	});

	test("a hidden-but-selected test source (config.source='test') still emits the row", async () => {
		getConfig().source = "test";
		await call(
			appRouter.streaming.setSourceVisibility,
			{ hide_test_pattern: true },
			{ context: makeContext() },
		);
		const test = getSourcesMessage().sources.find((s) => s.id === "test");
		expect(test).toBeDefined();
		expect(test?.available).toBe(false);
		expect(test?.unavailableReason).toBe(DISABLED_IN_SETTINGS_REASON);
		delete (getConfig() as { source?: unknown }).source;
	});
});
