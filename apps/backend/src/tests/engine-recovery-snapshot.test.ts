import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EventParams,
	rpcRequestSchema,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { MINIMAL_SAFE_CAPABILITIES } from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { bindEngineControlLoss } from "../modules/streaming/engine-control-loss.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

const jsonrpc = "2.0";
const frame = (value: object) => `${JSON.stringify(value)}\n`;
const status = (params: Extract<EventParams, { type: "status" }>) =>
	frame({ jsonrpc, method: "event", params });
const idle = {
	type: "status",
	seq: 1,
	state: "idle",
	streaming: false,
} as const;
const starting = {
	type: "status",
	seq: 2,
	state: "starting",
	streaming: false,
} as const;

test.each([
	["quiet Idle after UI restart", "idle", "idle", true],
	["snapshot in the subscribe reply read", "idle", "idle", true],
	[
		"a transition after the snapshot in the same read",
		"reconciling",
		"unknown",
		true,
	],
	["legacy capability absent", "reconciling", "unknown", undefined],
	["snapshot mode conflict", "reconciling", "unknown", true],
] as const)(
	"#629 recovery: %s",
	async (scenario, lifecycle, liveness, optIn) => {
		const dir = await mkdtemp(join(tmpdir(), "ss"));
		const socketPath = join(dir, "s");
		const requests: Array<readonly [number, string]> = [];
		const modes: unknown[] = [];
		const losses: string[] = [];
		const closed = Promise.withResolvers<void>();
		let connections = 0;
		let conflict = false;
		const server = Bun.listen<{ pending: string; id: number }>({
			unix: socketPath,
			socket: {
				open(peer) {
					peer.data = { pending: "", id: ++connections };
				},
				close() {
					closed.resolve();
				},
				data(peer, chunk) {
					const lines = (peer.data.pending + chunk.toString()).split("\n");
					peer.data.pending = lines.pop() ?? "";
					for (const line of lines) {
						const request = rpcRequestSchema.parse(JSON.parse(line));
						requests.push([peer.data.id, request.method]);
						const result = (value: object) =>
							frame({ jsonrpc, id: request.id, result: value });
						switch (request.method) {
							case "hello":
								peer.write(
									result({
										protocol: "cerastream-ipc/1",
										schema_version: SCHEMA_VERSION,
										engine_version: "fixture",
									}),
								);
								break;
							case "get-capabilities":
								peer.write(
									result({
										...MINIMAL_SAFE_CAPABILITIES,
										...(optIn ? { features: ["status-snapshot"] } : {}),
									}),
								);
								break;
							case "subscribe-events": {
								const mode =
									typeof request.params === "object" &&
									request.params !== null &&
									"snapshot" in request.params
										? request.params.snapshot
										: undefined;
								modes.push(mode);
								if (mode === true && scenario === "snapshot mode conflict") {
									conflict = true;
									peer.write(
										frame({
											jsonrpc,
											id: request.id,
											error: {
												code: -32602,
												message: "status mode already selected",
												data: { code: "cerastream.params.invalid" },
											},
										}) + status(idle),
									);
									break;
								}
								const reply = result({ subscribed: ["status"] });
								const snapshot =
									mode === true && optIn
										? status({ ...idle, snapshot: true })
										: "";
								if (scenario === "quiet Idle after UI restart") {
									peer.write(reply);
									if (snapshot) setImmediate(() => peer.write(snapshot));
								} else {
									peer.write(
										reply +
											snapshot +
											(scenario ===
											"a transition after the snapshot in the same read"
												? status(starting)
												: ""),
									);
								}
								break;
							}
							default:
								throw new Error(`Unexpected probe request: ${request.method}`);
						}
					}
				},
			},
		});
		let retained = true;
		let streaming = false;
		const backend = new CerastreamBackend({ connectOptions: { socketPath } });
		const session = createStreamSessionOrchestrator({
			initialLiveness: () => (retained ? "unknown" : "idle"),
			createAttemptId: () => "snapshot-fixture",
			stopRuntime: async () => {
				throw new Error("The read-only observer must not Stop");
			},
			getStreamingStatus: () => streaming,
			setStreamingStatus: (value) => {
				streaming = value;
			},
			queryRuntime: () => backend.reconcileRuntimeState(),
			unmarkStreamingForOta: () => {
				retained = false;
			},
		});
		bindEngineControlLoss((site) => losses.push(site));
		try {
			expect(await session.reconcile()).toBe(lifecycle);
			await closed.promise;
			expect(session.streamLiveness()).toBe(liveness);
			expect(retained).toBe(liveness !== "idle");
			if (scenario === "snapshot mode conflict") expect(conflict).toBe(true);
			expect(requests).toEqual([
				[1, "hello"],
				[1, "get-capabilities"],
				[1, "subscribe-events"],
			]);
			expect(modes).toEqual([optIn]);
			expect(connections).toBe(1);
			expect(losses).toEqual([]);
		} finally {
			bindEngineControlLoss();
			server.stop(true);
			await rm(dir, { recursive: true, force: true });
		}
	},
);
