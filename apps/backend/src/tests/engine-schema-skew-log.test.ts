import { beforeEach, expect, test } from "bun:test";
import {
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamTimeoutError,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	type CapabilitiesLogger,
	clearCapabilitiesCache,
	getCapabilities,
	invalidateCapabilities,
} from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";

// An older engine against newer bindings (for example schema 0.21 against 0.24):
// each probe and capability read sees the same hello, several times per start.
const ENGINE_SCHEMA = "0.0.1-older";

function logSpy() {
	const warns: Array<{ msg: string; meta?: unknown }> = [];
	const logger: CapabilitiesLogger = {
		debug: () => {},
		info: () => {},
		warn: (msg, meta) => warns.push({ msg, meta }),
		error: () => {},
	};
	return {
		logger,
		skewWarnings: () => warns.filter((w) => w.msg.includes("schema_version")),
	};
}

function helloClient(schemaVersion: string): CerastreamClient {
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: schemaVersion,
			engine_version: "2026.9.8",
		},
		close: async () => {},
	} as unknown as CerastreamClient;
}

function readCapabilities(logger: CapabilitiesLogger, schemaVersion: string) {
	return getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: false,
					hardware_accelerated: false,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["H264"],
					bitrate_range: { min: 500, max: 6000, unit: "kbps" },
				},
				sources: [],
			},
			schemaVersion,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger,
	});
}

beforeEach(() => {
	clearCapabilitiesCache();
});

test("one engine connection logs the schema skew once, with both versions", async () => {
	const spy = logSpy();
	const backend = new CerastreamBackend({
		connect: async () => helloClient(ENGINE_SCHEMA),
		logger: spy.logger,
	});

	await backend.probeEngine();
	await backend.probeEngine();
	const caps = await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	// The flag the UI reads is not affected by the quieter log.
	expect(caps.schemaVersionMismatch).toBe(true);
	expect(spy.skewWarnings()).toHaveLength(1);
	expect(spy.skewWarnings()[0]?.meta).toMatchObject({
		engine: ENGINE_SCHEMA,
		bindings: SCHEMA_VERSION,
	});
});

test("the settled engine's control liveness probes do not repeat the skew", async () => {
	const spy = logSpy();
	const backend = new CerastreamBackend({
		connect: async () => helloClient(ENGINE_SCHEMA),
		logger: spy.logger,
	});

	// The startup probe, then the transport-only probe the reconnect monitor
	// runs about every 15 s while the engine stays up.
	await backend.probeEngine();
	for (let i = 0; i < 8; i++) await backend.probeEngine(true);

	expect(spy.skewWarnings()).toHaveLength(1);
});

test("an engine that comes back after a failed probe logs the skew again", async () => {
	const spy = logSpy();
	let reachable = true;
	const backend = new CerastreamBackend({
		connect: async () => {
			if (!reachable) throw new CerastreamConnectionError("no socket");
			return helloClient(ENGINE_SCHEMA);
		},
		logger: spy.logger,
	});

	await backend.probeEngine();
	reachable = false;
	expect((await backend.probeEngine()).status).toBe("unreachable");
	reachable = true;
	await backend.probeEngine();

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a lost session connection re-arms the skew warning", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	invalidateCapabilities();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a capability read that finds the engine gone re-arms the skew warning", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await getCapabilities({
		fetchEngineCapabilities: async () => {
			throw new CerastreamConnectionError("engine restarting");
		},
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: spy.logger,
	});
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a different engine schema is logged at once", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, "0.0.2-older");

	expect(spy.skewWarnings()).toHaveLength(2);
	expect(spy.skewWarnings()[1]?.meta).toMatchObject({
		engine: "0.0.2-older",
		bindings: SCHEMA_VERSION,
	});
});

function pendingRead(logger: CapabilitiesLogger) {
	let settle!: {
		resolve: (schemaVersion: string) => void;
		reject: (error: Error) => void;
	};
	const answer = new Promise<string>((resolve, reject) => {
		settle = { resolve, reject };
	});
	const read = getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: false,
					hardware_accelerated: false,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["H264"],
					bitrate_range: { min: 500, max: 6000, unit: "kbps" },
				},
				sources: [],
			},
			schemaVersion: await answer,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger,
	});
	return { read, ...settle };
}

test("a read from a retired connection does not use up the next connection's warning", async () => {
	const spy = logSpy();
	const retired = pendingRead(spy.logger);
	invalidateCapabilities();
	retired.resolve(ENGINE_SCHEMA);
	await retired.read;
	expect(spy.skewWarnings()).toHaveLength(0);

	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	expect(spy.skewWarnings()).toHaveLength(1);
});

test("a read from a retired connection that fails does not re-arm the current one", async () => {
	const spy = logSpy();
	const retired = pendingRead(spy.logger);
	invalidateCapabilities();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	retired.reject(new CerastreamConnectionError("old socket closed"));
	await retired.read;
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(1);
});

test("a skew that comes back after a matching engine is logged again", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, SCHEMA_VERSION);
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a probe that sees a matching engine between two skewed ones logs twice", async () => {
	const spy = logSpy();
	let schema = ENGINE_SCHEMA;
	const backend = new CerastreamBackend({
		connect: async () => helloClient(schema),
		logger: spy.logger,
	});

	await backend.probeEngine();
	schema = SCHEMA_VERSION;
	await backend.probeEngine();
	schema = ENGINE_SCHEMA;
	await backend.probeEngine();

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("matching schemas log nothing", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, SCHEMA_VERSION);
	expect(spy.skewWarnings()).toHaveLength(0);
});

test("an inconclusive liveness probe keeps the skew warning used up", async () => {
	const spy = logSpy();
	let fail: Error | undefined;
	const backend = new CerastreamBackend({
		connect: async () => {
			if (fail) throw fail;
			return helloClient(ENGINE_SCHEMA);
		},
		logger: spy.logger,
	});

	await backend.probeEngine(true);
	// A hello timeout is not proof the engine is gone; the monitor treats the
	// engine as still reachable.
	fail = new CerastreamTimeoutError("hello timed out");
	expect((await backend.probeEngine(true)).status).toBe("error");
	fail = undefined;
	await backend.probeEngine(true);
	expect(spy.skewWarnings()).toHaveLength(1);

	// A lost control connection is proof, so the next connection reports again.
	fail = new CerastreamConnectionError("no socket");
	expect((await backend.probeEngine(true)).status).toBe("unreachable");
	fail = undefined;
	await backend.probeEngine(true);
	expect(spy.skewWarnings()).toHaveLength(2);
});

function pendingProbe(logger: CapabilitiesLogger) {
	let settle!: {
		resolve: (client: CerastreamClient) => void;
		reject: (error: Error) => void;
	};
	const connected = new Promise<CerastreamClient>((resolve, reject) => {
		settle = { resolve, reject };
	});
	const backend = new CerastreamBackend({
		connect: () => connected,
		logger,
	});
	return { probe: backend.probeEngine(true), ...settle };
}

test("a probe from a retired connection that succeeds late does not use up the next connection's warning", async () => {
	const spy = logSpy();
	const retired = pendingProbe(spy.logger);
	invalidateCapabilities();
	retired.resolve(helloClient(ENGINE_SCHEMA));
	await retired.probe;
	expect(spy.skewWarnings()).toHaveLength(0);

	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	expect(spy.skewWarnings()).toHaveLength(1);
});

test("a probe from a retired connection that fails late does not re-arm the current one", async () => {
	const spy = logSpy();
	const retired = pendingProbe(spy.logger);
	invalidateCapabilities();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	retired.reject(new CerastreamConnectionError("old socket closed"));
	expect((await retired.probe).status).toBe("unreachable");
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(1);
});

test("a capability read that reports the skew first names the engine release", async () => {
	const spy = logSpy();
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: false,
					hardware_accelerated: false,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["H264"],
					bitrate_range: { min: 500, max: 6000, unit: "kbps" },
				},
				sources: [],
			},
			schemaVersion: ENGINE_SCHEMA,
			engineVersion: "2026.9.8",
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: spy.logger,
	});

	expect(spy.skewWarnings()).toHaveLength(1);
	expect(spy.skewWarnings()[0]?.meta).toEqual({
		engine: ENGINE_SCHEMA,
		bindings: SCHEMA_VERSION,
		engineVersion: "2026.9.8",
	});
});

test("a capability read that times out keeps the skew warning used up", async () => {
	const spy = logSpy();
	const backend = new CerastreamBackend({
		connect: async () => helloClient(ENGINE_SCHEMA),
		logger: spy.logger,
	});

	await backend.probeEngine(true);
	// The request exceeded its deadline; that does not prove the engine is gone.
	const caps = await getCapabilities({
		fetchEngineCapabilities: async () => {
			throw new CerastreamTimeoutError("get-capabilities timed out");
		},
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: spy.logger,
	});
	expect(caps.engineUnavailable).toBe(true);
	await backend.probeEngine(true);

	expect(spy.skewWarnings()).toHaveLength(1);
});

test("a read that saw a matching engine before a skewed probe does not clear the probe's warning", async () => {
	const spy = logSpy();
	let finishScan!: () => void;
	const scanning = new Promise<void>((resolve) => {
		finishScan = resolve;
	});
	const read = getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: false,
					hardware_accelerated: false,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["H264"],
					bitrate_range: { min: 500, max: 6000, unit: "kbps" },
				},
				sources: [],
			},
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => {
			await scanning;
			return { devices: [] };
		},
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: spy.logger,
	});
	const backend = new CerastreamBackend({
		connect: async () => helloClient(ENGINE_SCHEMA),
		logger: spy.logger,
	});

	// The read has its matching answer and is still scanning devices when a
	// later probe sees the skew.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await backend.probeEngine(true);
	finishScan();
	await read;
	await backend.probeEngine(true);

	expect(spy.skewWarnings()).toHaveLength(1);
});
