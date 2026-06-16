import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type ConsoleLogInfo,
	formatConsoleEntry,
	shouldColorizeConsole,
} from "../helpers/logger.ts";

const ANSI_ESCAPE = "\x1b[";
const HH_MM_SS_RE = /\d{2}:\d{2}:\d{2}\.\d{3}/;

const SAMPLE: ConsoleLogInfo = {
	level: "info",
	message: "stream started",
	timestamp: "2026-06-14T09:08:07.654Z",
	links: 3,
};

let savedNodeEnv: string | undefined;
let savedIsTty: boolean | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedIsTty = process.stdout.isTTY;
});

afterEach(() => {
	if (savedNodeEnv === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = savedNodeEnv;
	}
	process.stdout.isTTY = savedIsTty as boolean;
});

describe("dev console formatter", () => {
	test("dev + TTY: line carries an ANSI escape and an HH:MM:SS timestamp", () => {
		process.env.NODE_ENV = "development";
		process.stdout.isTTY = true;

		expect(shouldColorizeConsole()).toBe(true);

		const line = formatConsoleEntry(SAMPLE, shouldColorizeConsole());
		expect(line).toContain(ANSI_ESCAPE);
		expect(line).toMatch(HH_MM_SS_RE);
	});

	test("dev but NOT a TTY: no ANSI escape, timestamp still present", () => {
		process.env.NODE_ENV = "development";
		process.stdout.isTTY = false;

		expect(shouldColorizeConsole()).toBe(false);

		const line = formatConsoleEntry(SAMPLE, shouldColorizeConsole());
		expect(line).not.toContain(ANSI_ESCAPE);
		expect(line).toMatch(HH_MM_SS_RE);
	});

	test("production (NODE_ENV unset) never colorizes even on a TTY", () => {
		delete process.env.NODE_ENV;
		delete process.env.MOCK_MODE;
		process.stdout.isTTY = true;

		expect(shouldColorizeConsole()).toBe(false);
		expect(formatConsoleEntry(SAMPLE, shouldColorizeConsole())).not.toContain(
			ANSI_ESCAPE,
		);
	});

	test("error/warn/info/debug each get a distinct ANSI badge when colorized", () => {
		const levels = ["error", "warn", "info", "debug"] as const;
		const badges = levels.map((level) =>
			formatConsoleEntry({ ...SAMPLE, level }, true),
		);
		for (const badge of badges) {
			expect(badge).toContain(ANSI_ESCAPE);
		}
		expect(new Set(badges).size).toBe(levels.length);
	});

	test("metadata renders as multi-line indented JSON", () => {
		const line = formatConsoleEntry(SAMPLE, false);
		expect(line).toContain("\n  ");
		expect(line).toContain('"links": 3');
	});
});
