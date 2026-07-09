import { beforeEach, describe, expect, test } from "bun:test";

import type { StreamHealthOutput } from "@ceraui/rpc/schemas";

import {
	type BootGuardLogger,
	guardNonCritical,
	runCritical,
} from "./helpers/boot-guard.ts";
import {
	type BackendShutdownDeps,
	handleTerminationSignal,
	resetShutdownForTest,
} from "./helpers/shutdown.ts";
import {
	buildLocalObservabilitySurface,
	type LocalObservabilitySurface,
} from "./modules/system/observability.ts";
import {
	getBootReadiness,
	isBootDegraded,
	resetBootReadiness,
} from "./modules/system/readiness.ts";

const silent: BootGuardLogger = { info: () => {}, error: () => {} };

const HEALTHY_ROLLUP: StreamHealthOutput = {
	state: "healthy",
	process: { alive: true },
	frames: { advancing: true, count: 10 },
	srt: { reconnecting: false, reconnectCount: 0 },
	bond: { linkCount: 1, activeLinks: 1 },
};

interface BootInit {
	name: string;
	run: () => Promise<void> | void;
}

// Mirror of the main.ts boot ordering: the CRITICAL WS-control-server bind runs
// BEFORE every NON-CRITICAL init, and each non-critical init is fail-soft-guarded.
// A non-critical throw must never reach the critical bind nor abort the chain.
async function simulateBoot(opts: {
	bindServer: () => void;
	nonCritical: BootInit[];
	logger?: BootGuardLogger;
}): Promise<{ serverBound: boolean }> {
	const log = opts.logger ?? silent;
	let serverBound = false;
	await runCritical(
		"ws-control-server",
		() => {
			opts.bindServer();
			serverBound = true;
		},
		{ logger: log },
	);
	for (const init of opts.nonCritical) {
		await guardNonCritical(init.name, init.run, { logger: log });
	}
	return { serverBound };
}

beforeEach(() => {
	resetBootReadiness();
	resetShutdownForTest();
});

describe("guardNonCritical — fail-soft non-critical init", () => {
	test("swallows a failure and flags the subsystem degraded", async () => {
		const ok = await guardNonCritical(
			"pipelines",
			() => {
				throw new Error("engine IPC down");
			},
			{ logger: silent },
		);

		expect(ok).toBe(false);
		expect(isBootDegraded()).toBe(true);
		expect(getBootReadiness().degradedSubsystems).toEqual(["pipelines"]);
	});

	test("catches an async rejection the same way", async () => {
		const ok = await guardNonCritical(
			"control-channel",
			async () => {
				throw new Error("dial failed");
			},
			{ logger: silent },
		);

		expect(ok).toBe(false);
		expect(getBootReadiness().degradedSubsystems).toContain("control-channel");
	});

	test("returns true and leaves readiness nominal on success", async () => {
		const ok = await guardNonCritical("identity", () => {}, {
			logger: silent,
		});

		expect(ok).toBe(true);
		expect(isBootDegraded()).toBe(false);
		expect(getBootReadiness()).toEqual({
			degraded: false,
			degradedSubsystems: [],
		});
	});

	test("does not double-list a subsystem that fails twice", async () => {
		const throwOnce = (msg: string) => () => {
			throw new Error(msg);
		};
		await guardNonCritical("pipelines", throwOnce("x"), { logger: silent });
		await guardNonCritical("pipelines", throwOnce("y"), { logger: silent });

		expect(getBootReadiness().degradedSubsystems).toEqual(["pipelines"]);
	});
});

describe("runCritical — critical init aborts on failure", () => {
	test("runs the init and flags no degradation on success", async () => {
		let ran = false;
		await runCritical(
			"config",
			() => {
				ran = true;
			},
			{ logger: silent },
		);

		expect(ran).toBe(true);
		expect(isBootDegraded()).toBe(false);
	});

	test("re-throws the original error so the process aborts", async () => {
		await expect(
			runCritical(
				"config",
				() => {
					throw new Error("config.json corrupt");
				},
				{ logger: silent },
			),
		).rejects.toThrow("config.json corrupt");
		// A critical failure is NOT a readiness flag — it aborts.
		expect(isBootDegraded()).toBe(false);
	});
});

describe("boot contract — degraded-but-up vs critical abort", () => {
	test("a non-critical init failure degrades readiness but the WS server still binds", async () => {
		const ran: string[] = [];
		let serverListening = false;

		const result = await simulateBoot({
			bindServer: () => {
				serverListening = true;
			},
			nonCritical: [
				{ name: "identity", run: () => void ran.push("identity") },
				{
					name: "control-channel",
					run: () => void ran.push("control-channel"),
				},
				{
					name: "pipelines",
					run: () => {
						ran.push("pipelines");
						throw new Error("engine unreachable");
					},
				},
				{ name: "rtmp-ingest", run: () => void ran.push("rtmp-ingest") },
			],
			logger: silent,
		});

		expect(result.serverBound).toBe(true);
		expect(serverListening).toBe(true);

		expect(isBootDegraded()).toBe(true);
		expect(getBootReadiness()).toEqual({
			degraded: true,
			degradedSubsystems: ["pipelines"],
		});

		expect(ran).toEqual([
			"identity",
			"control-channel",
			"pipelines",
			"rtmp-ingest",
		]);
	});

	test("a critical WS-control-server bind failure aborts boot", async () => {
		const ran: string[] = [];

		await expect(
			simulateBoot({
				bindServer: () => {
					throw new Error("EADDRINUSE: all ports exhausted");
				},
				nonCritical: [
					{ name: "identity", run: () => void ran.push("identity") },
				],
				logger: silent,
			}),
		).rejects.toThrow("EADDRINUSE");

		expect(ran).toEqual([]);
	});
});

describe("/api/health surface — operator-visible degraded flag", () => {
	test("carries the degraded readiness rollup once a subsystem fails", async () => {
		await guardNonCritical(
			"pipelines",
			() => {
				throw new Error("down");
			},
			{ logger: silent },
		);

		const surface: LocalObservabilitySurface = buildLocalObservabilitySurface(
			HEALTHY_ROLLUP,
			42,
			new Date("2026-06-25T00:00:00.000Z"),
			getBootReadiness(),
		);

		expect(surface.readiness).toEqual({
			degraded: true,
			degradedSubsystems: ["pipelines"],
		});
	});

	test("omits readiness when none is supplied (back-compat with existing callers)", () => {
		const surface = buildLocalObservabilitySurface(HEALTHY_ROLLUP, 42);
		expect(surface.readiness).toBeUndefined();
	});
});

describe("termination shutdown lifecycle", () => {
	test("SIGTERM cleanup drains SRT ingest, dmesg watchers, then streamloop before exit", async () => {
		const calls: string[] = [];
		let resolveGraceful: (() => void) | undefined;
		const deps: BackendShutdownDeps = {
			stopSrtIngest: async () => {
				calls.push("srt");
			},
			stopDmesgWatchers: () => {
				calls.push("dmesg");
			},
			gracefulShutdown: () =>
				new Promise<void>((resolve) => {
					calls.push("streamloop");
					resolveGraceful = resolve;
				}),
			exit: (code) => {
				calls.push(`exit:${code}`);
			},
		};

		handleTerminationSignal("SIGTERM", deps);
		handleTerminationSignal("SIGINT", deps);
		await Bun.sleep(0);

		expect(calls).toEqual(["srt", "dmesg", "streamloop"]);
		resolveGraceful?.();
		await Bun.sleep(0);
		expect(calls).toEqual(["srt", "dmesg", "streamloop", "exit:0"]);
	});
});
