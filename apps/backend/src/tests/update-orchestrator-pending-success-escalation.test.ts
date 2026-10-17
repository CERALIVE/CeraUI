import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { pendingSuccessFixture } from "./helpers/pending-success-fixture.ts";

afterEach(resetBootReadiness);

test("five consecutive legitimate disk mismatches escalate once while keeping success fenced", async () => {
	// Given a benign phase timestamp rewrite that cannot be replayed exactly.
	using h = pendingSuccessFixture();
	pendingPackageSuccess.observe();
	saveOrchestratorState({ ...h.baseline, enteredAt: 99 }, h.file);
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	try {
		// When the existing scheduler retries across and beyond the drift budget.
		for (let attempt = 0; attempt < 4; attempt++)
			await pendingPackageSuccess.retry();
		expect(getBootReadiness().degradedSubsystems).not.toContain(
			"update-orchestrator-maintenance",
		);
		for (let attempt = 0; attempt < 5; attempt++)
			await pendingPackageSuccess.retry();
		// Then maintenance is explicit and deduplicated, never mistaken for clearance.
		expect(getBootReadiness().degradedSubsystems).toContain(
			"update-orchestrator-maintenance",
		);
		expect(
			log.mock.calls.filter((call) => {
				const meta: unknown = Array.from(call).at(1);
				return (
					typeof meta === "object" &&
					meta !== null &&
					"reason" in meta &&
					meta.reason === "package_success_baseline_drift"
				);
			}),
		).toHaveLength(1);
		expect(h.writes).toBe(0);
		expect(pendingPackageSuccess.pending).toBe(true);
	} finally {
		log.mockRestore();
	}
});

test("a disk phase outside package completion escalates immediately without clearing its fence", async () => {
	// Given an observed package completion replaced by an unrelated idle snapshot.
	using h = pendingSuccessFixture();
	pendingPackageSuccess.observe();
	saveOrchestratorState(initialOrchestratorState(99), h.file);
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	try {
		// When replay reads that authoritative replacement twice.
		await pendingPackageSuccess.retry();
		await pendingPackageSuccess.retry();
		// Then one reasoned escalation requests diagnosis and leaves authority closed.
		expect(
			log.mock.calls.filter((call) => {
				const meta: unknown = Array.from(call).at(1);
				return (
					typeof meta === "object" &&
					meta !== null &&
					"reason" in meta &&
					meta.reason === "package_success_phase_changed"
				);
			}),
		).toHaveLength(1);
		expect(getBootReadiness().degradedSubsystems).toContain(
			"update-orchestrator-maintenance",
		);
		expect(pendingPackageSuccess.pending).toBe(true);
		expect(h.writes).toBe(0);
	} finally {
		log.mockRestore();
	}
});

test("repeat persistence failure logs once per signature and at most once per minute thereafter", async () => {
	// Given the same retained fault with a controlled scheduler clock.
	using h = pendingSuccessFixture();
	pendingPackageSuccess.observe();
	saveOrchestratorState({ ...h.baseline, enteredAt: 99 }, h.file);
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	try {
		// When repeated attempts remain below the drift escalation budget.
		await pendingPackageSuccess.retry();
		h.now += 3_000;
		await pendingPackageSuccess.retry();
		expect(log).toHaveBeenCalledTimes(1);
		h.now += 60_000;
		await pendingPackageSuccess.retry();
		// Then the repeated signature appears only at the minute floor.
		expect(log).toHaveBeenCalledTimes(2);
	} finally {
		log.mockRestore();
	}
});
