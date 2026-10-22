/// <reference types="bun" />

import { afterEach, expect, it } from "bun:test";
import { z } from "zod";
import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import {
	AptAllRefusalError,
	assertPinnedInstallSimulation,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";
import {
	logAptAllRefusal,
	resetAptAllRefusalLogForTest,
} from "../modules/system/apt-all-refusal-log.ts";

afterEach(resetAptAllRefusalLogForTest);

function refusal(action: () => void): AptAllRefusalError {
	try {
		action();
	} catch (error) {
		if (error instanceof AptAllRefusalError) return error;
		throw error;
	}
	throw new Error("expected a parser refusal");
}

it("retains the pinned-recheck step when row parsing refuses", () => {
	// Given/When
	const error = refusal(() =>
		assertPinnedInstallSimulation("Inst nginx invalid", [
			{ name: "nginx", version: "1" },
		]),
	);
	// Then
	expect(error.step).toBe("pinned-recheck");
	expect(error.reason).toBe("discovery_failed");
	expect(error.detail).toContain("Inst nginx invalid");
});

it("journals identical discovery and pinned parse failures independently", () => {
	// Given
	clearRecentLogLines();
	const text = "Inst nginx invalid";
	const discovery = refusal(() => {
		parseAptSimulation(text);
	});
	const pinned = refusal(() =>
		assertPinnedInstallSimulation(text, [{ name: "nginx", version: "1" }]),
	);
	// When
	for (const error of [discovery, pinned, discovery, pinned])
		logAptAllRefusal(error);
	// Then
	const record = z.object({
		meta: z.object({ step: z.string(), stage: z.string() }),
	});
	expect(
		getRecentLogLines().map((line) => record.parse(JSON.parse(line)).meta),
	).toEqual([
		{ step: "parse-simulation", stage: "parse" },
		{ step: "pinned-recheck", stage: "parse" },
	]);
});
