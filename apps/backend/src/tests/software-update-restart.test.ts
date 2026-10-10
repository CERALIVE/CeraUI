import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { finishSoftwareUpdateRestart } from "../modules/system/software-update-restart.ts";

afterEach(resetBootReadiness);

test("restart waits when durable completion permission is pending", async () => {
	// Given an owner whose durable write is held.
	const permission = Promise.withResolvers<boolean>();
	let exited = false;
	// When success requests termination.
	const tail = finishSoftwareUpdateRestart(
		() => permission.promise,
		() => {
			exited = true;
		},
	);
	// Then only positive completion permits it.
	expect(exited).toBe(false);
	permission.resolve(true);
	await tail;
	expect(exited).toBe(true);
});

test("restart is withheld and degraded when persistence throws", async () => {
	// Given a failed durable owner.
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	let exited = false;
	try {
		// When the completion callback fails.
		await finishSoftwareUpdateRestart(
			() => {
				throw new Error("fixture fsync failed");
			},
			() => {
				exited = true;
			},
		);
		// Then the backend stays available for maintenance.
		expect(exited).toBe(false);
		expect(getBootReadiness().degradedSubsystems).toEqual([
			"update-orchestrator-maintenance",
		]);
		expect(log).toHaveBeenCalledTimes(1);
	} finally {
		log.mockRestore();
	}
});

test("standalone restart remains immediate when there is no owner", async () => {
	// Given a legacy standalone completion.
	let exited = false;
	// When its cleanup has completed.
	const tail = finishSoftwareUpdateRestart(undefined, () => {
		exited = true;
	});
	// Then there is no new asynchronous admission boundary.
	expect(exited).toBe(true);
	await tail;
});

test("restart stays withheld when the owner refuses durable permission", async () => {
	// Given an adjudicated safety refusal.
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	let exited = false;
	try {
		// When the explicit handshake answers false.
		await finishSoftwareUpdateRestart(
			async () => false,
			() => {
				exited = true;
			},
		);
		// Then no restart can turn consumed success into missing-unit failure.
		expect(exited).toBe(false);
		expect(getBootReadiness().degradedSubsystems).toContain(
			"update-orchestrator-maintenance",
		);
		expect(log).toHaveBeenCalledTimes(1);
	} finally {
		log.mockRestore();
	}
});
