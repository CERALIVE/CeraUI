import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CerastreamConnectionError,
	rpcRequestSchema,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { setup } from "../modules/setup.ts";
import {
	clearCapabilitiesCache,
	getLastCapabilities,
	MINIMAL_SAFE_CAPABILITIES,
} from "../modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	initEngineConnection,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import { searchPipelines } from "../modules/streaming/pipelines.ts";
import * as sources from "../modules/streaming/sources.ts";
import {
	reconcileStreamSession,
	streamLiveness,
} from "../modules/streaming/stream-session-orchestrator.ts";
import {
	getHardwareKind,
	getHardwareKindCached,
	resetHardwareKindCache,
} from "../modules/system/hardware-kind.ts";

test.each(["success", "connection loss"] as const)(
	"shutdown cannot let a pending boot probe publish capabilities or pipelines after %s",
	async (outcome) => {
		const probe = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const staleSource = "retired-boot-probe";
		clearCapabilitiesCache();
		const boot = initEngineConnection({
			capabilities: {
				fetchEngineCapabilities: async () => {
					probe.resolve();
					await release.promise;
					if (outcome === "connection loss")
						throw new CerastreamConnectionError("Engine not up");
					return {
						caps: {
							...MINIMAL_SAFE_CAPABILITIES,
							sources: MINIMAL_SAFE_CAPABILITIES.sources.map((source) => ({
								...source,
								id: staleSource,
							})),
						},
						schemaVersion: SCHEMA_VERSION,
					};
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			},
			sources: { fetchEngineDevices: async () => ({ devices: [] }) },
		});
		try {
			await probe.promise;
			stopEngineReconnect();
			release.resolve();
			await boot;
			expect(getLastCapabilities()).toBeUndefined();
			expect(searchPipelines(staleSource)).toBeNull();
		} finally {
			release.resolve();
			await boot;
			stopEngineReconnect();
			clearCapabilitiesCache();
		}
	},
);

test("shutdown revokes a boot heal already waiting on stream status", async () => {
	const retry = Promise.withResolvers<() => void>();
	const observed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<"streaming">();
	const runtime = spyOn(
		cerastreamBackend,
		"reconcileRuntimeState",
	).mockImplementation(() => {
		observed.resolve();
		return release.promise;
	});
	const refresh = spyOn(
		sources,
		"refreshAndBroadcastSources",
	).mockResolvedValue(undefined);
	let up = false;
	clearCapabilitiesCache();
	try {
		await initEngineConnection({
			capabilities: {
				fetchEngineCapabilities: async () => {
					if (!up) throw new CerastreamConnectionError("Engine not up");
					return {
						caps: MINIMAL_SAFE_CAPABILITIES,
						schemaVersion: SCHEMA_VERSION,
					};
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			},
			setTimer(callback) {
				retry.resolve(callback);
				const handle = setTimeout(callback, 0);
				clearTimeout(handle);
				return handle;
			},
		});
		up = true;
		(await retry.promise)();
		const heal = settleEngineReconnect();
		await observed.promise;
		stopEngineReconnect();
		release.resolve("streaming");
		await heal;
		expect(streamLiveness()).toBe("unknown");
	} finally {
		release.resolve("streaming");
		stopEngineReconnect();
		runtime.mockResolvedValue("idle");
		await reconcileStreamSession();
		runtime.mockRestore();
		refresh.mockRestore();
		clearCapabilitiesCache();
	}
});

test("a hardware reply from a stopped recovery cannot replace the cached board kind", async () => {
	const work = await mkdtemp(join(tmpdir(), "cs"));
	const socketPath = join(work, "s");
	const retry = Promise.withResolvers<() => void>();
	const hardwareRead = Promise.withResolvers<() => void>();
	const server = Bun.listen<{ pending: string }>({
		unix: socketPath,
		socket: {
			open(peer) {
				peer.data = { pending: "" };
			},
			data(peer, chunk) {
				const lines = (peer.data.pending + chunk.toString()).split("\n");
				peer.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const { id, method } = rpcRequestSchema.parse(JSON.parse(line));
					if (method === "hello") {
						peer.write(
							`${JSON.stringify({ jsonrpc: "2.0", id, result: { protocol: "cerastream-ipc/1" } })}\n`,
						);
					}
					if (method === "get-capabilities") {
						hardwareRead.resolve(() => {
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id,
									result: { platform: { hardware_kind: "n100" } },
								})}\n`,
							);
						});
					}
				}
			},
		},
	});
	const previous = setup.cerastream_socket;
	setup.cerastream_socket = socketPath;
	clearCapabilitiesCache();
	resetHardwareKindCache();
	let heal: Promise<void> | undefined;
	let up = false;
	try {
		await getHardwareKind({ probeEngine: async () => "rk3588" });
		await initEngineConnection({
			capabilities: {
				fetchEngineCapabilities: async () => {
					if (!up) throw new CerastreamConnectionError("Engine not up");
					return {
						caps: MINIMAL_SAFE_CAPABILITIES,
						schemaVersion: SCHEMA_VERSION,
					};
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			},
			sources: { fetchEngineDevices: async () => ({ devices: [] }) },
			setTimer(callback) {
				retry.resolve(callback);
				const handle = setTimeout(callback, 0);
				clearTimeout(handle);
				return handle;
			},
		});
		up = true;
		(await retry.promise)();
		heal = settleEngineReconnect();
		const reply = await hardwareRead.promise;
		stopEngineReconnect();
		reply();
		await heal;

		expect(getHardwareKindCached()).toBe("rk3588");
	} finally {
		stopEngineReconnect();
		server.stop(true);
		await heal;
		if (previous === undefined) delete setup.cerastream_socket;
		else setup.cerastream_socket = previous;
		resetHardwareKindCache();
		clearCapabilitiesCache();
		await rm(work, { recursive: true, force: true });
	}
});
