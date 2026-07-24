import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { CerastreamClient, StartParams } from "@ceralive/cerastream";
import type { StreamSource } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { writeFileAtomicSync } from "../helpers/config-loader.ts";
import {
	coerceLegacySource,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import * as configMigration from "../modules/streaming/config-migration.ts";
import * as sourcesModule from "../modules/streaming/sources.ts";
import {
	deriveEngineRouting,
	resolveSourceRouting,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import * as streamloop from "../modules/streaming/streamloop.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The live sources list the mocked getSourcesMessage() serves to the procedures.
// video0 = a capture source bridged to the `hdmi` pipeline; `test` = the virtual
// pattern; `usb_mjpeg` = a coarse source; `rtmp` = a network source. `nope` is
// deliberately absent so it resolves to unknown_source.
const FIXTURE_SOURCES: StreamSource[] = [
	{
		origin: "capture",
		id: "video0",
		pipelineId: "hdmi",
		kind: "hdmi",
		displayName: "HDMI Capture",
		devicePath: "/dev/video0",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
	},
	{
		origin: "coarse",
		id: "usb_mjpeg",
		pipelineId: "usb_mjpeg",
		labelKey: "settings.sources.usb_mjpeg",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
	},
	{
		origin: "virtual",
		id: "test",
		pipelineId: "test",
		labelKey: "settings.sources.test",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
	},
	{
		origin: "network",
		id: "rtmp",
		pipelineId: "rtmp",
		labelKey: "settings.sources.rtmp",
		requiresGateway: "rtmp",
		url: "rtmp://10.0.0.5:1935/publish/live",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: true,
	},
];

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

// ---------------------------------------------------------------------------
// coerceLegacySource — the load-time legacy migration matrix
// ---------------------------------------------------------------------------

describe("coerceLegacySource — legacy pipeline/input → source migration", () => {
	test("derives source='video0' from a capture config (selected_video_input wins)", () => {
		const migrated = coerceLegacySource({
			pipeline: "hdmi",
			selected_video_input: "video0",
		});
		expect(migrated.source).toBe("video0");
		// The engine-wire fields are preserved — never removed.
		expect(migrated.pipeline).toBe("hdmi");
		expect(migrated.selected_video_input).toBe("video0");
	});

	test("derives source='rtmp' from a network pipeline", () => {
		expect(coerceLegacySource({ pipeline: "rtmp" }).source).toBe("rtmp");
		expect(coerceLegacySource({ pipeline: "srt" }).source).toBe("srt");
	});

	test("derives source='test' from the virtual pipeline", () => {
		expect(coerceLegacySource({ pipeline: "test" }).source).toBe("test");
	});

	test("derives a coarse source id from a bare pipeline, leaving selected_video_input unset", () => {
		const migrated = coerceLegacySource({ pipeline: "hdmi" });
		expect(migrated.source).toBe("hdmi");
		expect(migrated.selected_video_input).toBeUndefined();
	});

	test("passes an already-set source through untouched (idempotent)", () => {
		const already: RuntimeConfig = { pipeline: "hdmi", source: "video0" };
		expect(coerceLegacySource(already)).toBe(already);
		// A second pass is a no-op.
		expect(coerceLegacySource(coerceLegacySource(already)).source).toBe(
			"video0",
		);
	});

	test("leaves source unset when there is nothing to derive", () => {
		expect(coerceLegacySource({}).source).toBeUndefined();
		expect(coerceLegacySource({ max_br: 5000 }).source).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// resolveSourceRouting / deriveEngineRouting — pure routing
// ---------------------------------------------------------------------------

describe("resolveSourceRouting — chosen source id → engine routing", () => {
	test("a capture source routes to its bridged pipeline + input_id", () => {
		const routed = resolveSourceRouting("video0", FIXTURE_SOURCES);
		expect(routed).toEqual({
			ok: true,
			pipeline: "hdmi",
			selected_video_input: "video0",
		});
	});

	test("a virtual source routes to its pipeline and CLEARS selected_video_input", () => {
		const routed = resolveSourceRouting("test", FIXTURE_SOURCES);
		expect(routed).toEqual({
			ok: true,
			pipeline: "test",
			selected_video_input: undefined,
		});
	});

	test("a coarse source routes to its pipeline and clears the input", () => {
		expect(resolveSourceRouting("usb_mjpeg", FIXTURE_SOURCES)).toEqual({
			ok: true,
			pipeline: "usb_mjpeg",
			selected_video_input: undefined,
		});
	});

	test("an unknown source id → { ok:false, error:'unknown_source' }", () => {
		expect(resolveSourceRouting("nope", FIXTURE_SOURCES)).toEqual({
			ok: false,
			error: "unknown_source",
		});
		// deriveEngineRouting (the wrapped primitive) returns undefined for it.
		expect(deriveEngineRouting("nope", FIXTURE_SOURCES)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Engine-seam StartParams byte-identity (cerastream-backend.ts unmodified)
// ---------------------------------------------------------------------------

function makeStartParamsSpy(): {
	client: CerastreamClient;
	get: () => StartParams | undefined;
} {
	let captured: StartParams | undefined;
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "test",
			engine_version: "test",
		},
		subscribeEvents: async () => ({
			result: { subscribed: [] },
			close: () => {},
		}),
		start: async (params: StartParams) => {
			captured = params;
			return { session_id: "s1", state: "streaming" as const };
		},
		stop: async () => ({ state: "idle" as const }),
		close: async () => {},
	} as unknown as CerastreamClient;
	return { client, get: () => captured };
}

async function dispatchStartParams(
	config: RuntimeConfig,
): Promise<StartParams> {
	const spy = makeStartParamsSpy();
	const backend = new CerastreamBackend({
		connect: async () => spy.client,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-source-test.json",
		getActiveInput: () => "active-fallback-input",
		isEmbeddedAudioActive: () => false,
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
	});
	await backend.start(config, {
		pipeline: "hdmi",
		host: "127.0.0.1",
		port: 9000,
		streamid: "stream-1",
	});
	await backend.settle();
	const params = spy.get();
	if (params === undefined)
		throw new Error("engine start was never dispatched");
	return params;
}

describe("start-dispatch byte-identity — a coarse source changes nothing on the wire", () => {
	test("a bare {pipeline:'hdmi'} config and its coerced source='hdmi' twin dispatch IDENTICAL StartParams", async () => {
		const today: RuntimeConfig = {
			pipeline: "hdmi",
			max_br: 8000,
			srt_latency: 2000,
			balancer: "adaptive",
		};
		const coerced = coerceLegacySource({ ...today });
		// The coercion added a source but left selected_video_input unset.
		expect(coerced.source).toBe("hdmi");
		expect(coerced.selected_video_input).toBeUndefined();

		const paramsToday = await dispatchStartParams(today);
		const paramsCoerced = await dispatchStartParams(coerced);

		expect(paramsCoerced).toEqual(paramsToday);
		// input_id is still populated by the existing getActiveInput() fallback —
		// a coarse source injects NO input_id of its own.
		expect(paramsCoerced.input_id).toBe("active-fallback-input");
		expect(paramsCoerced.pipeline).toBe("hdmi");
	});

	test("a virtual source dispatches pipeline 'test' at the engine seam", async () => {
		const params = await dispatchStartParams({
			source: "test",
			pipeline: "test",
			max_br: 8000,
			srt_latency: 2000,
			balancer: "adaptive",
		});
		expect(params.pipeline).toBe("test");
	});
});

// ---------------------------------------------------------------------------
// Persistence round-trip through the atomic writer
// ---------------------------------------------------------------------------

describe("config.json round-trip through writeFileAtomicSync", () => {
	const TMP = path.join("/tmp", `ceraui-source-roundtrip-${process.pid}.json`);
	afterAll(() => {
		try {
			fs.unlinkSync(TMP);
		} catch {
			// already gone
		}
	});

	test("a coerced source persists and re-parses clean", () => {
		const coerced = coerceLegacySource({
			pipeline: "hdmi",
			selected_video_input: "video0",
		});
		writeFileAtomicSync(TMP, JSON.stringify(coerced));

		const reloaded = JSON.parse(fs.readFileSync(TMP, "utf8"));
		const parsed = runtimeConfigSchema.safeParse(reloaded);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.source).toBe("video0");
		expect(parsed.data?.pipeline).toBe("hdmi");
		expect(parsed.data?.selected_video_input).toBe("video0");
	});
});

// ---------------------------------------------------------------------------
// cerastream-backend.ts is untouched by this todo (mirrors T2's assertion)
// ---------------------------------------------------------------------------

describe("source routing stays isolated from cerastream-backend.ts", () => {
	function git(args: string[], cwd: string): string {
		const proc = Bun.spawnSync(["git", ...args], { cwd });
		return new TextDecoder().decode(proc.stdout);
	}

	test("Todo 26 lifecycle changes do not import or rebuild source routing", () => {
		const repoRoot = git(
			["rev-parse", "--show-toplevel"],
			process.cwd(),
		).trim();
		expect(repoRoot.length).toBeGreaterThan(0);

		const TEST_REL = "apps/backend/src/tests/config-source-migration.test.ts";
		const BACKEND_REL =
			"apps/backend/src/modules/streaming/cerastream-backend.ts";

		// baseline = the commit that ADDED this test, minus one (this todo's parent
		// tree). Before that commit exists (initial local run) the test is untracked,
		// so fall back to HEAD (working-tree vs the last commit).
		const addCommit = git(
			["log", "--diff-filter=A", "--format=%H", "-1", "--", TEST_REL],
			repoRoot,
		).trim();
		const baseline = addCommit.length > 0 ? `${addCommit}^` : "HEAD";

		const diff = git(["diff", baseline, "--", BACKEND_REL], repoRoot).trim();
		// The guard's scope is the START ASSEMBLY routing (buildStartParams /
		// encodeInputAudioFields) — not whole-file byte-equality. Telemetry reads
		// like extractActiveEncode evolve independently; the positive test below
		// asserts the same choke-point invariant.
		for (const chokePoint of ["./sources.ts", "buildSources"]) {
			expect(diff).not.toContain(chokePoint);
		}
	});

	test("the start choke point still reads config.pipeline / selected_video_input", async () => {
		const backend = await Bun.file(
			new URL("../modules/streaming/cerastream-backend.ts", import.meta.url),
		).text();
		expect(backend).toContain("config.pipeline ?? opts.pipeline");
		expect(backend).toContain(
			"config.selected_video_input ?? this.deps.getActiveInput()",
		);
	});
});

// ---------------------------------------------------------------------------
// Procedure layer — setConfig + start source resolution (module-mocked)
// ---------------------------------------------------------------------------

const STREAMLOOP_PATH = "../modules/streaming/streamloop.ts";
const SOURCES_PATH = "../modules/streaming/sources.ts";
const CONFIG_MIGRATION_PATH = "../modules/streaming/config-migration.ts";

// Snapshot the REAL modules at load time (before any mock.module runs). afterAll
// MUST restore from these, NOT from the live `sourcesModule`/`configMigration`
// bindings — bun's mock.module mutates those namespaces in place, so spreading
// them post-mock would re-install the mock permanently (leaking FIXTURE_SOURCES
// into every later test's getSourcesMessage — a cross-file isolation break).
const realStreamloop = { ...streamloop };
const realSources = { ...sourcesModule };
const realConfigMigration = { ...configMigration };

// session.start stand-in: records every launch so we can prove it is skipped on a
// rejected source and dispatches the resolved pipeline on a known one.
const startSpy = mock(async (_conn: unknown, _params: unknown) => ({
	success: true as const,
}));

let setConfigProcedure: Awaited<
	typeof import("../rpc/procedures/streaming.procedure.ts")
>["setConfigProcedure"];
let streamingStartProcedure: Awaited<
	typeof import("../rpc/procedures/streaming.procedure.ts")
>["streamingStartProcedure"];

describe("streaming procedures — device-first source resolution", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(async () => {
		// Force the real (non-mock) start path so the start handler reaches
		// startStream (the mocked session.start), and inject a deterministic
		// sources list + an always-valid offered-set gate.
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "test";

		mock.module(SOURCES_PATH, () => ({
			...sourcesModule,
			getSourcesMessage: () => ({
				hardware: "rk3588" as const,
				sources: FIXTURE_SOURCES,
			}),
		}));
		mock.module(CONFIG_MIGRATION_PATH, () => ({
			...configMigration,
			validatePersistedPipeline: () => ({ valid: true }),
		}));
		mock.module(STREAMLOOP_PATH, () => ({
			...realStreamloop,
			start: startSpy,
			stop: () => {},
		}));

		const proc = await import("../rpc/procedures/streaming.procedure.ts");
		setConfigProcedure = proc.setConfigProcedure;
		streamingStartProcedure = proc.streamingStartProcedure;
	});

	afterAll(() => {
		mock.module(SOURCES_PATH, () => ({ ...realSources }));
		mock.module(CONFIG_MIGRATION_PATH, () => ({ ...realConfigMigration }));
		mock.module(STREAMLOOP_PATH, () => ({ ...realStreamloop }));
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	beforeEach(() => {
		startSpy.mockClear();
		const config = getConfig();
		config.source = undefined;
		config.pipeline = undefined;
		config.selected_video_input = undefined;
	});

	afterEach(() => {
		updateStatus(false);
		const config = getConfig();
		config.source = undefined;
		config.pipeline = undefined;
		config.selected_video_input = undefined;
	});

	test("setConfig({source:'video0'}) applies the derived pipeline + input_id", async () => {
		const result = await call(
			setConfigProcedure,
			{ source: "video0" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(result.applied?.source).toBe("video0");
		expect(result.applied?.pipeline).toBe("hdmi");
		expect(result.applied?.selected_video_input).toBe("video0");
		expect(getConfig().pipeline).toBe("hdmi");
		expect(getConfig().selected_video_input).toBe("video0");
		expect(getConfig().source).toBe("video0");
	});

	test("setConfig({source:'test'}) after a capture selection CLEARS selected_video_input", async () => {
		await call(
			setConfigProcedure,
			{ source: "video0" },
			{ context: makeContext() },
		);
		expect(getConfig().selected_video_input).toBe("video0");

		const result = await call(
			setConfigProcedure,
			{ source: "test" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(result.applied?.pipeline).toBe("test");
		expect(result.applied?.selected_video_input).toBeUndefined();
		expect(getConfig().pipeline).toBe("test");
		expect(getConfig().selected_video_input).toBeUndefined();
		expect(getConfig().source).toBe("test");
	});

	test("setConfig({max_br}) alone still succeeds unchanged (partial-merge regression guard)", async () => {
		const result = await call(
			setConfigProcedure,
			{ max_br: 5000 },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(result.applied?.max_br).toBe(5000);
		// A non-source write must never touch source/pipeline/input.
		expect(result.applied?.source).toBeUndefined();
		expect(getConfig().max_br).toBe(5000);
		expect(getConfig().source).toBeUndefined();
	});

	test("setConfig({source:'nope'}) rejects at the procedure with disk unchanged", async () => {
		const config = getConfig();
		config.pipeline = "hdmi";
		config.source = "video0";
		config.selected_video_input = "video0";

		const result = await call(
			setConfigProcedure,
			{ source: "nope" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("unknown_source");
		// Disk unchanged — the pre-existing config is untouched.
		expect(config.pipeline).toBe("hdmi");
		expect(config.source).toBe("video0");
		expect(config.selected_video_input).toBe("video0");
	});

	test("start with a persisted config.source='nope' rejects WITHOUT invoking session.start", async () => {
		getConfig().source = "nope";

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("unknown_source");
		expect(startSpy).toHaveBeenCalledTimes(0);
	});

	test("start({source:'test'}) dispatches pipeline 'test' to session.start", async () => {
		const result = await call(
			streamingStartProcedure,
			{ source: "test" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(startSpy).toHaveBeenCalledTimes(1);
		const dispatched = startSpy.mock.calls[0]?.[1] as {
			pipeline?: string;
			source?: string;
			selected_video_input?: string;
		};
		expect(dispatched.pipeline).toBe("test");
		expect(dispatched.source).toBe("test");
		expect(dispatched.selected_video_input).toBeUndefined();
	});

	// F2 Bug 1: with no persisted config.source, asserting dispatched.source (the
	// value updateConfig persists as config.source) — not merely dispatched.pipeline
	// — is the point; the pre-fix stream still got the right pipeline yet never
	// persisted the source.
	test("a sole-camera Start ({source:'video0'}, no persisted source) dispatches source→pipeline→input to session.start", async () => {
		const config = getConfig();
		config.source = undefined;
		config.pipeline = undefined;
		config.selected_video_input = undefined;

		const result = await call(
			streamingStartProcedure,
			{ source: "video0" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(startSpy).toHaveBeenCalledTimes(1);
		const dispatched = startSpy.mock.calls[0]?.[1] as {
			pipeline?: string;
			source?: string;
			selected_video_input?: string;
		};
		expect(dispatched.source).toBe("video0");
		expect(dispatched.pipeline).toBe("hdmi");
		expect(dispatched.selected_video_input).toBe("video0");
		expect(result.applied?.source).toBe("video0");
		expect(result.applied?.pipeline).toBe("hdmi");
		expect(result.applied?.selected_video_input).toBe("video0");
	});
});
