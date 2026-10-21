/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	defaultUpdateDetailsDeps,
	readUpdateDetails,
} from "../modules/system/update-orchestrator/details.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import { credentialObserverFixture } from "./helpers/credential-observer-fixture.ts";
import { resetNotificationState } from "./helpers/notification-state.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

beforeEach(resetNotificationState);
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	resetNotificationState();
});

test.each(["live", "automation-off", "recovery-gated"] as const)(
	"tick observes credentials while %s",
	async (mode) => {
		// Given an update scheduler unable to run work; When ticked; Then its independent credential observer still publishes.
		const fixture = await credentialObserverFixture();
		let observation: Promise<void> = Promise.resolve();
		try {
			setOrchestratorRuntimeDepsForTest(
				fakeDeps({
					isStreamLive: () => mode === "live",
					isUpdateAdmissionReady: async () => mode !== "recovery-gated",
					loadSettings: async () => ({
						packagesAuto: false,
						systemAuto: false,
						schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
						channel: "stable",
						allowPackagesOverCellular: false,
						allowSystemOverCellular: false,
					}),
					observeCredentials: () => {
						observation = fixture.observer.refresh(true);
						return observation;
					},
				}),
			);
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "checking",
			});
			await runOrchestratorTick();
			await observation;
			expect(getPersistentNotifications(true).show).toHaveLength(1);
			expect(getOrchestratorState().phase).toBe("checking");
		} finally {
			fixture.observer.stop();
			await fixture.cleanup();
		}
	},
);

test.each(["held", "throws", "rejects"] as const)(
	"%s observer cannot block tick or stream admission",
	async (fault) => {
		// Given a broken/held advisory port; When tick and Start admission run; Then their outcomes settle independently.
		let release: () => void = () => {};
		let calls = 0;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isUpdateAdmissionReady: async () => false,
				observeCredentials: () => {
					calls++;
					switch (fault) {
						case "held":
							return held;
						case "throws":
							throw new Error("credential-advisory-sentinel");
						case "rejects":
							return Promise.reject(new Error("credential-advisory-sentinel"));
						default: {
							const exhaustive: never = fault;
							return exhaustive;
						}
					}
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		try {
			await runOrchestratorTick();
			expect(calls).toBe(1);
			const admission = await admitAndPrepareStreamStart();
			expect(admission).toEqual({ allowed: true });
			expect(getOrchestratorState().phase).toBe("idle");
		} finally {
			release();
			await held;
		}
	},
);

test.each(["valid", "expiring", "expired", "unavailable"] as const)(
	"details RPC projection is read-only when %s",
	async (state) => {
		// Given a cached public observation; When details are pulled; Then the same safe block returns without notice publication.
		const credentials = {
			expiresAt: state === "unavailable" ? null : 123,
			state,
		};
		const result = await readUpdateDetails({
			...defaultUpdateDetailsDeps,
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
			readBootedVersion: async () => undefined,
			orchestratorState: () => initialOrchestratorState(0),
			credentials: () => credentials,
		});
		expect(result.credentials).toEqual(credentials);
		expect(getPersistentNotifications(true).show).toHaveLength(0);
	},
);

test("details credential getter fault is unavailable without losing other blocks", async () => {
	// Given a failed credential projection; When details are read; Then only credentials degrade and raw errors are absent.
	const result = await readUpdateDetails({
		...defaultUpdateDetailsDeps,
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		readBootedVersion: async () => "2026.10.1",
		orchestratorState: () => initialOrchestratorState(0),
		credentials: () => {
			throw new Error("/client.key digest-sentinel");
		},
	});
	expect(result.credentials).toEqual({ expiresAt: null, state: "unavailable" });
	expect(result.os.bootedVersion).toBe("2026.10.1");
	expect(JSON.stringify(result)).not.toContain("digest-sentinel");
});
