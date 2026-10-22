/// <reference types="bun" />

import { afterEach, expect, it } from "bun:test";
import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import { AptAllRefusalError } from "../modules/system/apt-all-packages.ts";
import {
	logAptAllRefusal,
	resetAptAllRefusalLogForTest,
} from "../modules/system/apt-all-refusal-log.ts";

afterEach(resetAptAllRefusalLogForTest);

it("trims a surrogate straddling the journal display boundary", () => {
	// Given
	clearRecentLogLines();
	const error = new AptAllRefusalError("discovery_failed", "simulation", {
		detail: `${"x".repeat(299)}😀suffix`,
	});
	// When
	logAptAllRefusal(error);
	// Then: inspect production JSON, including the escaped unpaired-surrogate form.
	const rendered = getRecentLogLines().join("\n");
	expect(rendered).toContain(`"detail":"${"x".repeat(299)}"`);
	expect(rendered).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
});
