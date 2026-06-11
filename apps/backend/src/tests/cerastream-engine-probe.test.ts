import { describe, expect, test } from "bun:test";
import {
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
	type ConnectOptions,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	CerastreamBackend,
	checkEngineCompatibilityOnStartup,
	classifyEngineProbeError,
	ENGINE_COMPAT_NOTIFICATION,
	type EngineProbe,
} from "../modules/streaming/cerastream-backend.ts";

// A minimal hello-only fake client. `close()` is tracked so we can assert the
// probe always disconnects (it must never leave a dangling connection).
function fakeClient(hello: Partial<CerastreamClient["hello"]> = {}): {
	client: CerastreamClient;
	closed: () => number;
} {
	let closes = 0;
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: SCHEMA_VERSION,
			engine_version: "2026.6.0",
			...hello,
		},
		close: async () => {
			closes += 1;
		},
	} as unknown as CerastreamClient;
	return { client, closed: () => closes };
}

interface LogSpy {
	logger: {
		debug: (m: string, x?: unknown) => void;
		info: (m: string, x?: unknown) => void;
		warn: (m: string, x?: unknown) => void;
		error: (m: string, x?: unknown) => void;
	};
	warns: Array<{ msg: string; meta?: unknown }>;
	errors: Array<{ msg: string; meta?: unknown }>;
	infos: Array<{ msg: string; meta?: unknown }>;
}

function logSpy(): LogSpy {
	const warns: Array<{ msg: string; meta?: unknown }> = [];
	const errors: Array<{ msg: string; meta?: unknown }> = [];
	const infos: Array<{ msg: string; meta?: unknown }> = [];
	return {
		warns,
		errors,
		infos,
		logger: {
			debug: () => {},
			info: (msg, meta) => infos.push({ msg, meta }),
			warn: (msg, meta) => warns.push({ msg, meta }),
			error: (msg, meta) => errors.push({ msg, meta }),
		},
	};
}

function backendWith(
	connect: (options?: ConnectOptions) => Promise<CerastreamClient>,
	logger?: LogSpy["logger"],
): CerastreamBackend {
	return new CerastreamBackend({ connect, ...(logger ? { logger } : {}) });
}

describe("classifyEngineProbeError", () => {
	test("protocol-unsupported RPC error → protocol_incompatible (by dataCode)", () => {
		const err = new CerastreamRpcError(
			-32000,
			"unsupported protocol",
			"cerastream.protocol.unsupported_version",
			1,
		);
		expect(classifyEngineProbeError(err).status).toBe("protocol_incompatible");
	});

	test("numeric -32000 alone → protocol_incompatible (by code)", () => {
		const err = new CerastreamRpcError(-32000, "nope", undefined, 1);
		expect(classifyEngineProbeError(err).status).toBe("protocol_incompatible");
	});

	test("a ZodError-shaped failure → protocol_incompatible", () => {
		const err = Object.assign(new Error("bad hello shape"), {
			name: "ZodError",
		});
		expect(classifyEngineProbeError(err).status).toBe("protocol_incompatible");
	});

	test("connection error → unreachable", () => {
		const err = new CerastreamConnectionError("ECONNREFUSED");
		expect(classifyEngineProbeError(err).status).toBe("unreachable");
	});

	test("timeout error → unreachable", () => {
		const err = new CerastreamTimeoutError("hello", 2000);
		expect(classifyEngineProbeError(err).status).toBe("unreachable");
	});

	test("a non-protocol RPC error → error", () => {
		const err = new CerastreamRpcError(
			-32004,
			"out of range",
			"cerastream.bitrate.out_of_range",
			1,
		);
		expect(classifyEngineProbeError(err).status).toBe("error");
	});

	test("an unknown failure → error", () => {
		expect(classifyEngineProbeError(new Error("boom")).status).toBe("error");
	});
});

describe("CerastreamBackend.probeEngine", () => {
	test("compatible engine returns the hello fields and disconnects", async () => {
		const f = fakeClient();
		const backend = backendWith(async () => f.client);

		const probe = await backend.probeEngine();

		expect(probe.status).toBe("compatible");
		expect(probe.protocol).toBe("cerastream-ipc/1");
		expect(probe.engineVersion).toBe("2026.6.0");
		expect(probe.schemaVersion).toBe(SCHEMA_VERSION);
		expect(f.closed()).toBe(1); // probe must always close its connection
	});

	test("warns (non-fatally) on schema_version skew within the same major", async () => {
		const f = fakeClient({ schema_version: "9.9.9-different" });
		const spy = logSpy();
		const backend = backendWith(async () => f.client, spy.logger);

		const probe = await backend.probeEngine();

		expect(probe.status).toBe("compatible"); // skew is informational only
		expect(spy.warns.some((w) => w.msg.includes("schema_version"))).toBe(true);
	});

	test("protocol-major mismatch surfaces as protocol_incompatible", async () => {
		const backend = backendWith(async () => {
			throw new CerastreamRpcError(
				-32000,
				"this server speaks cerastream-ipc/1",
				"cerastream.protocol.unsupported_version",
				1,
			);
		});

		const probe = await backend.probeEngine();

		expect(probe.status).toBe("protocol_incompatible");
	});

	test("an unreachable engine surfaces as unreachable", async () => {
		const backend = backendWith(async () => {
			throw new CerastreamConnectionError("no socket");
		});

		expect((await backend.probeEngine()).status).toBe("unreachable");
	});
});

describe("checkEngineCompatibilityOnStartup", () => {
	function notifySpy() {
		const calls: Array<{
			name: string;
			type: string;
			msg: string;
			persistent: boolean;
		}> = [];
		const notify = (
			name: string,
			type: "success" | "warning" | "error",
			msg: string,
			_duration: number,
			isPersistent: boolean,
		) => {
			calls.push({ name, type, msg, persistent: isPersistent });
		};
		return { calls, notify };
	}

	test("protocol_incompatible raises a persistent error notification", async () => {
		const spyN = notifySpy();
		const spyL = logSpy();

		await checkEngineCompatibilityOnStartup({
			probe: async (): Promise<EngineProbe> => ({
				status: "protocol_incompatible",
				detail: "mismatch",
			}),
			notify: spyN.notify,
			logger: spyL.logger,
		});

		expect(spyN.calls).toHaveLength(1);
		expect(spyN.calls[0]?.name).toBe(ENGINE_COMPAT_NOTIFICATION);
		expect(spyN.calls[0]?.type).toBe("error");
		expect(spyN.calls[0]?.persistent).toBe(true);
		expect(spyL.errors).toHaveLength(1);
	});

	test("unreachable only logs a warning — no user notification", async () => {
		const spyN = notifySpy();
		const spyL = logSpy();

		await checkEngineCompatibilityOnStartup({
			probe: async (): Promise<EngineProbe> => ({ status: "unreachable" }),
			notify: spyN.notify,
			logger: spyL.logger,
		});

		expect(spyN.calls).toHaveLength(0);
		expect(spyL.warns).toHaveLength(1);
	});

	test("compatible logs info and does not notify", async () => {
		const spyN = notifySpy();
		const spyL = logSpy();

		await checkEngineCompatibilityOnStartup({
			probe: async (): Promise<EngineProbe> => ({
				status: "compatible",
				protocol: "cerastream-ipc/1",
				engineVersion: "2026.6.0",
			}),
			notify: spyN.notify,
			logger: spyL.logger,
		});

		expect(spyN.calls).toHaveLength(0);
		expect(spyL.infos).toHaveLength(1);
	});
});
