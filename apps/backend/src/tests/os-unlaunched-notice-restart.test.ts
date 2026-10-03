import { afterEach, beforeEach, expect, test } from "bun:test";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { osStageNoticeId } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	D8_STATE,
	identifiedState,
	KEY,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
function clearStore() {
	for (const n of getPersistentNotifications(true).show)
		notificationRemove(n.name);
}
beforeEach(clearStore);
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
	clearStore();
});

test.each(["operator", "unsafe", "automatic"] as const)(
	"hydrates a missing %s notice from persisted policy in a fresh store",
	async (mode) => {
		// Given restart with no notice in memory and no surviving witness.
		const f = runtimeFixture();
		fixtures.push(f);
		const state = mode === "unsafe" ? D8_STATE : identifiedState();
		const record = state.osStageRecovery;
		if (!record) throw new Error("fixture record missing");
		const policy = {
			...state,
			phase:
				mode === "unsafe" ? ("failed" as const) : ("os-available" as const),
			failureReason:
				mode === "unsafe" ? "rauc_recovery_unproven" : "rauc_install_failed",
			osStageRecovery: {
				...record,
				mode,
				reason:
					mode === "unsafe" ? "rauc_recovery_unproven" : "rauc_install_failed",
				nextRetryAt: mode === "automatic" ? 1790999999999 : null,
			},
		};
		saveOrchestratorState(policy, f.file);
		notifyUpdate({
			kind: "refused",
			id: "os-check:expired",
			reason: "expired",
		});
		const unrelated = getPersistentNotifications(true).show[0];
		// When production startup hydrates its validated persisted policy.
		await startUpdateOrchestrator(f.deps);
		// Then the missing policy notice appears and unrelated notices are byte-untouched.
		const notices = getPersistentNotifications(true).show;
		const kind =
			mode === "unsafe"
				? "os-stage-unresolved"
				: mode === "automatic"
					? "os-stage-retry"
					: "os-stage-operator";
		expect(
			notices.find(
				(n) =>
					n.name === `update:${kind}:${osStageNoticeId(record.candidateKey)}`,
			)?.params,
		).toEqual({ version: "2026.10.52" });
		expect(
			notices.find((n) => n.name === "update:refused:os-check:expired"),
		).toEqual(unrelated);
	},
);

test("does not remove or re-show the accepted operator notice during failed consume replay", async () => {
	// Given an accepted settlement whose witness consumption failed after durable state.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const consumeFault = () => {
		throw new Error("consume fault");
	};
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			consumeOsUnlaunchedWitness: consumeFault,
		}),
	).rejects.toThrow("consume fault");
	const name = `update:os-stage-operator:${osStageNoticeId(KEY)}`;
	const accepted = getPersistentNotifications(true).show.find(
		(n) => n.name === name,
	);
	expect(accepted).toBeDefined();
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		consumeOsUnlaunchedWitness: consumeFault,
	});
	// When cleanup replays twice without another reducer transition.
	await expect(runOrchestratorTick()).rejects.toThrow("consume fault");
	await expect(runOrchestratorTick()).rejects.toThrow("consume fault");
	// Then revision and content stay exactly as accepted, without remove/show churn.
	expect(
		getPersistentNotifications(true).show.find((n) => n.name === name),
	).toEqual(accepted);
});
