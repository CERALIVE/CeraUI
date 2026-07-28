import type { Svelte5Translation } from "@ceraui/i18n";
import { describe, expect, it } from "vitest";

import { configChangeReport } from "./configChangeCopy";

const LL = {
	live: {
		encoder: {
			applyPhase: {
				applied: () => "New settings are live",
				reverted: () => "Could not apply.",
				rollbackFailed: () => "Could not apply, and the stream stopped",
				reasonTeardownTimeout: () => "The camera was not released in time.",
				reasonDeadlineExceeded: () => "The change took longer than expected.",
				reasonEngineLost: () => "The engine stopped responding.",
				reasonRejected: () => "The device could not use those settings.",
				reasonUnknown: () => "Check the system logs.",
			},
		},
	},
	notifications: { saveFailed: () => "Save failed" },
} as unknown as Svelte5Translation;

describe("config-change operator copy", () => {
	it("reports applied as a success", () => {
		expect(
			configChangeReport({ result: "applied", attemptId: "a1" }, LL),
		).toEqual({
			level: "success",
			message: "New settings are live",
		});
	});

	it("reports reverted as a WARNING, not a success — the save was accepted but nothing changed", () => {
		const report = configChangeReport(
			{ result: "reverted", attemptId: "a1", reason: "not_negotiated" },
			LL,
		);
		expect(report.level).toBe("warning");
		expect(report.message).toContain("Could not apply.");
	});

	it("maps the teardown_timeout escalation to keyed operator copy", () => {
		const report = configChangeReport(
			{
				result: "rollback_failed",
				attemptId: "a1",
				reason: "teardown_timeout",
			},
			LL,
		);
		expect(report.level).toBe("error");
		expect(report.message).toContain("The camera was not released in time.");
	});

	it("maps the deadline and engine-loss reasons to their own sentences", () => {
		expect(
			configChangeReport(
				{
					result: "rollback_failed",
					attemptId: "a1",
					reason: "change_deadline_exceeded",
				},
				LL,
			).message,
		).toContain("took longer than expected");
		expect(
			configChangeReport(
				{
					result: "rollback_failed",
					attemptId: "a1",
					reason: "engine_connection_lost",
				},
				LL,
			).message,
		).toContain("stopped responding");
	});

	it("reports a refused change as a warning naming the refusal, never a rollback failure", () => {
		const report = configChangeReport(
			{ result: "reverted", attemptId: "a1", reason: "change_rejected" },
			LL,
		);
		expect(report.level).toBe("warning");
		expect(report.message).toContain("could not use those settings");
		expect(report.message).not.toContain("stream stopped");
	});

	it("NEVER renders a raw engine reason — an unmapped token points at the logs instead", () => {
		const report = configChangeReport(
			{
				result: "rollback_failed",
				attemptId: "a1",
				reason: "alsa: hw:CARD=rockchiphdmiin is busy",
			},
			LL,
		);
		expect(report.message).not.toContain("hw:CARD=");
		expect(report.message).toContain("Check the system logs.");
	});

	it("treats busy/rejected as a plain failed save — nothing about the stream changed", () => {
		expect(configChangeReport({ result: "busy" }, LL)).toEqual({
			level: "error",
			message: "Save failed",
		});
		expect(
			configChangeReport({ result: "rejected", reason: "x" }, LL).message,
		).toBe("Save failed");
	});
});
