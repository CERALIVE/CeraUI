import { onTestFinished } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTEMPT_SCOPED_START_FEATURE,
	type CheckMicRoutesParams,
	type CheckMicRoutesResult,
	cancelStartSchema,
	checkMicRoutesParamsSchema,
	type EventParams,
	type GetCapabilitiesResult,
	MIC_ROUTE_CHECK_FEATURE,
	type ReloadConfigParams,
	RPC_ERROR_NUMERIC,
	type RpcErrorCode,
	reloadConfigParamsSchema,
	rpcRequestSchema,
	SCHEMA_VERSION,
	type StartParams,
	setBitrateParamsSchema,
	startParamsSchema,
} from "@ceralive/cerastream";

export const attempt = "40cc1000-7013-42ca-8994-6808596684eb";
export const capacity = "cerastream.state.attempt_capacity";
export const cancelled = "cerastream.state.start_cancelled";
const notOwner = "cerastream.state.not_owner";
export const busy = "cerastream.state.already_streaming";
const capabilities = {
	platform: {
		supports_h265: false,
		hardware_accelerated: true,
		max_resolution: "1920x1080",
	},
	encoder: {
		codecs: ["h264"],
		bitrate_range: { min: 1, max: 8000, unit: "kbps" },
	},
	sources: [],
} satisfies GetCapabilitiesResult;
export type Scenario =
	| "lost"
	| "deadline"
	| "foreign-deadline"
	| "foreign-ambiguous"
	| "negotiation-deadline"
	| "malformed"
	| "foreign"
	| "cancelled"
	| "not-owner"
	| "capacity"
	| "legacy"
	| "legacy-deadline"
	| "legacy-success"
	| "old"
	| "success"
	| "unknown";
type Peer = { pending: string; prepared: boolean; index: number };

export async function scopedStartPeer(
	scenario: Scenario,
	micRoutes?: (
		request: CheckMicRoutesParams,
	) => CheckMicRoutesResult | Promise<CheckMicRoutesResult>,
) {
	const dir = await mkdtemp(join(tmpdir(), "scoped-"));
	const path = join(dir, "engine.sock");
	const requests: { method: string; peer: number; attemptId?: string }[] = [];
	const startAudio: StartParams["audio"][] = [];
	const reloads: ReloadConfigParams[] = [];
	const launchParams: StartParams[] = [];
	const checks: { peer: number; params: CheckMicRoutesParams }[] = [];
	let offerMicRoutes = micRoutes !== undefined;
	let refuseVerified = false;
	const entered = Promise.withResolvers<void>();
	const negotiating = Promise.withResolvers<void>();
	const sendLaunchStatus =
		Promise.withResolvers<(event: EventParams) => void>();
	const replyStart = Promise.withResolvers<() => void>();
	const launchClosed = Promise.withResolvers<void>();
	let physical: "idle" | "ours" | "foreign" =
		scenario === "foreign" ||
		scenario === "not-owner" ||
		scenario === "foreign-deadline" ||
		scenario === "foreign-ambiguous" ||
		scenario === "negotiation-deadline" ||
		scenario === "unknown" ||
		scenario === "malformed"
			? "foreign"
			: "idle";
	let peers = 0;
	let releaseLegacyStart: (() => void) | undefined;
	let sendStatus: (() => void) | undefined;
	const server = Bun.listen<Peer>({
		unix: path,
		socket: {
			open(socket) {
				socket.data = { pending: "", prepared: false, index: ++peers };
			},
			close(socket) {
				if (socket.data.index === 1) launchClosed.resolve();
			},
			data(socket, bytes) {
				socket.data.pending += bytes.toString();
				const lines = socket.data.pending.split("\n");
				socket.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const request = rpcRequestSchema.parse(JSON.parse(line));
					const record: (typeof requests)[number] = {
						method: request.method,
						peer: socket.data.index,
					};
					requests.push(record);
					const send = (payload: object) =>
						socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
					const reply = (result: unknown) => send({ id: request.id, result });
					const refuse = (code: RpcErrorCode) =>
						send({
							id: request.id,
							error: {
								code: RPC_ERROR_NUMERIC[code],
								message: code,
								data: { code },
							},
						});
					switch (request.method) {
						case "hello":
							reply({
								protocol: "cerastream-ipc/1",
								schema_version: scenario === "old" ? "0.24.0" : SCHEMA_VERSION,
								engine_version: "fixture",
							});
							break;
						case "get-capabilities":
							negotiating.resolve();
							if (
								scenario === "negotiation-deadline" &&
								socket.data.index === 1
							)
								break;
							if (scenario === "malformed" && socket.data.index === 1) {
								reply({ ...capabilities, features: "attempt-scoped-start" });
							} else if (scenario === "unknown" && socket.data.index === 1) {
								send({
									id: request.id,
									error: { code: -32601, message: "method not found" },
								});
							} else {
								reply({
									...capabilities,
									features:
										micRoutes !== undefined
											? [
													ATTEMPT_SCOPED_START_FEATURE,
													...(offerMicRoutes ? [MIC_ROUTE_CHECK_FEATURE] : []),
												]
											: scenario === "legacy" ||
													scenario === "legacy-deadline" ||
													scenario === "legacy-success"
												? []
												: [ATTEMPT_SCOPED_START_FEATURE],
								});
							}
							break;
						case "subscribe-events":
							reply({ subscribed: ["status"] });
							if (socket.data.index > 1) {
								// The binding installs the event handler in the reply continuation.
								sendStatus = () =>
									send({
										method: "event",
										params: {
											type: "status",
											seq: 1,
											state: physical === "idle" ? "idle" : "streaming",
											streaming: physical !== "idle",
										},
									});
							}
							break;
						case "prepare-start":
							if (scenario === "capacity") refuse(capacity);
							else {
								socket.data.prepared = true;
								reply({ attempt_id: attempt, expires_in_ms: 30_000 });
							}
							break;
						case "check-mic-routes": {
							const params = checkMicRoutesParamsSchema.parse(request.params);
							checks.push({ peer: socket.data.index, params });
							if (micRoutes === undefined)
								throw new Error("unexpected route check");
							void Promise.resolve(micRoutes(params)).then(reply);
							break;
						}
						case "set-bitrate":
							reply({ applied: setBitrateParamsSchema.parse(request.params) });
							break;
						case "reload-config": {
							const params = reloadConfigParamsSchema.parse(request.params);
							reloads.push(params);
							reply({ applied: params });
							break;
						}
						case "start":
						case "start-verified": {
							const params = startParamsSchema.parse(request.params);
							startAudio.push(params.audio);
							launchParams.push(params);
							if (params.attempt_id !== undefined)
								record.attemptId = params.attempt_id;
							entered.resolve();
							if (params.attempt_id !== undefined && !socket.data.prepared)
								refuse(notOwner);
							else if (request.method === "start-verified" && refuseVerified)
								refuse("cerastream.audio.device_not_found");
							else if (scenario === "foreign") refuse(busy);
							else if (scenario === "malformed") refuse("cerastream.internal");
							else if (scenario === "cancelled") refuse(cancelled);
							else if (scenario === "capacity") refuse(capacity);
							else if (scenario === "not-owner") socket.end();
							else if (scenario === "foreign-ambiguous")
								refuse("cerastream.internal");
							else if (scenario === "foreign-deadline")
								releaseLegacyStart = () => refuse(cancelled);
							else {
								physical = "ours";
								if (scenario === "lost") socket.end();
								else if (scenario === "success") {
									sendLaunchStatus.resolve((event) =>
										send({ method: "event", params: event }),
									);
									replyStart.resolve(() =>
										reply({
											session_id: "cs-1",
											state: "streaming",
											attempt_id: attempt,
										}),
									);
								} else if (scenario === "legacy-success") {
									reply({
										session_id: "cs-1",
										state: "streaming",
										attempt_id: params.attempt_id,
									});
								} else if (
									scenario === "deadline" ||
									scenario === "legacy-deadline"
								) {
									releaseLegacyStart = () => refuse(cancelled);
								} else refuse("cerastream.internal");
							}
							break;
						}
						case "cancel-start": {
							const params = cancelStartSchema.parse(request.params);
							record.attemptId = params.attempt_id;
							if (params.attempt_id !== attempt || physical !== "ours")
								refuse(notOwner);
							else {
								physical = "idle";
								reply(params);
							}
							break;
						}
						case "stop":
							physical = "idle";
							releaseLegacyStart?.();
							reply({ state: "idle" });
							break;
					}
				}
			},
		},
	});
	onTestFinished(async () => {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	});
	return {
		path,
		publishStatus: () => {
			const publish = sendStatus;
			sendStatus = undefined;
			publish?.();
		},
		entered: entered.promise,
		negotiating: negotiating.promise,
		launchClosed: launchClosed.promise,
		sendLaunchStatus: sendLaunchStatus.promise,
		replyStart: replyStart.promise,
		capabilityReads: () =>
			requests.filter(({ method }) => method === "get-capabilities"),
		starts: () =>
			requests.filter(
				({ method }) => method === "start" || method === "start-verified",
			),
		startAudio,
		reloads,
		launchParams,
		checks,
		disableMicRoutes: () => {
			offerMicRoutes = false;
		},
		refuseVerifiedStart: () => {
			refuseVerified = true;
		},
		prepares: () => requests.filter(({ method }) => method === "prepare-start"),
		cancels: () => requests.filter(({ method }) => method === "cancel-start"),
		stops: () => requests.filter(({ method }) => method === "stop"),
		physical: () => physical,
	};
}
