import { onTestFinished } from "bun:test";
import { connect, type EventParams } from "@ceralive/cerastream";
import type { LifecycleState } from "@ceraui/rpc/schemas";
import { CerastreamBackend } from "../../modules/streaming/cerastream-backend.ts";
import { createStreamSessionOrchestrator } from "../../modules/streaming/stream-session-orchestrator.ts";
import { type Scenario, scopedStartPeer } from "./scoped-start-peer.ts";

export async function launchHarness(scenario: Scenario) {
	const peer = await scopedStartPeer(scenario);
	const statusFrames: EventParams[] = [];
	const wireReceived = Promise.withResolvers<void>();
	const firstStatus = Promise.withResolvers<void>();
	const thirdWireFrame = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<LifecycleState>();
	const deadline = Promise.withResolvers<() => void>();
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	let frames = 0;
	let marked = false;
	onTestFinished(async () => {
		for (const client of clients) await client.close();
	});
	const config = {
		max_br: 8000,
		balancer: "adaptive" as const,
		pipeline: "test",
	};
	const backend = new CerastreamBackend({
		onEngineStatus: (event) => {
			statusFrames.push(event);
			firstStatus.resolve();
		},
		connect: async (options) => {
			const client = await connect({ ...options, socketPath: peer.path });
			clients.push(client);
			if (scenario === "success") {
				await client.subscribeEvents({ topics: ["status"] }, () => {
					wireReceived.resolve();
					if (++frames === 3) thirdWireFrame.resolve();
				});
			}
			return client;
		},
		getConfig: () => config,
		scheduleTimeout: (callback, delayMs) => {
			peer.publishStatus();
			return setTimeout(callback, delayMs);
		},
	});
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "ui-attempt",
		initialLiveness: () => "idle",
		setStreamingStatus: () => undefined,
		markStreamingForOta: () => {
			marked = true;
		},
		unmarkStreamingForOta: () => {
			marked = false;
		},
		setLifecycleState: (state) => {
			if (state === "streaming" || state === "idle") observed.resolve(state);
		},
		queryRuntime: () => backend.reconcileRuntimeState(),
		stopRuntime: async () => {
			await new Promise<void>((resolve, reject) => {
				if (!backend.stop(resolve, reject))
					void backend.confirmStop().then(resolve, reject);
			});
		},
		retryPolicy: {
			maxAttempts:
				scenario === "deadline" ||
				scenario === "negotiation-deadline" ||
				scenario === "legacy-deadline"
					? 1
					: 3,
			totalBudgetMs: 30_000,
			baseDelayMs: 1,
			maxDelayMs: 1,
			attemptTimeoutMs: 15_000,
		},
		scheduleLaunchDeadline: (fire, ms) => {
			if (ms === 15_000) deadline.resolve(fire);
			return setTimeout(fire, ms);
		},
	});
	return {
		...peer,
		start: () =>
			session.start({
				origin: "ui",
				launch: () =>
					backend.start(config, {
						pipeline: "test",
						host: "127.0.0.1",
						port: 9000,
						streamid: "test",
					}),
			}),
		statusFrames,
		wireReceived: wireReceived.promise,
		firstStatus: firstStatus.promise,
		thirdWireFrame: thirdWireFrame.promise,
		deadline: deadline.promise,
		observed: observed.promise,
		view: () => ({
			physical: peer.physical(),
			marked,
			state: session.snapshot().state,
		}),
	};
}
