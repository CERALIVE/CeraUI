import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ok as assert } from "node:assert/strict";
import winston from "winston";
import * as logging from "../helpers/logger.ts";

const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
	LOG_LEVEL: process.env.LOG_LEVEL,
};
const consoleTransport = logging.logger.transports.find(
	(transport) => transport instanceof winston.transports.Console,
);
assert(consoleTransport?.level);
const savedLevel = consoleTransport.level;
const captured: string[] = [];

function emit(level: string, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		logging.logger.write({ level, message }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.LOG_LEVEL;
	captured.length = 0;
	spyOn(consoleTransport, "log").mockImplementation((info, next) => {
		captured.push(String(info[Symbol.for("message")]));
		next();
	});
});

afterEach(() => {
	spyOn(consoleTransport, "log").mockRestore();
	consoleTransport.level = savedLevel;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("journal console records", () => {
	test.each([
		["error", "<3>"],
		["warn", "<4>"],
		["info", "<6>"],
		["http", "<7>"],
		["debug", "<7>"],
	])("%s carries %s before redacted JSON", async (level, prefix) => {
		consoleTransport.level = "silly";
		await new Promise<void>((resolve, reject) => {
			logging.logger.write(
				{ level, message: "journal-test-record", token: "v4.public.abc" },
				(error) => (error ? reject(error) : resolve()),
			);
		});
		expect(captured).toHaveLength(1);
		const line = captured[0];
		assert(line);
		expect(line.startsWith(prefix)).toBe(true);
		expect(JSON.parse(line.slice(3))).toMatchObject({
			level,
			msg: "journal-test-record",
			meta: { token: "[REDACTED]" },
		});
		expect(line).not.toContain("v4.public.abc");
	});

	test.each(["development", "mock"])(
		"%s selects pretty output per record",
		async (mode) => {
			if (mode === "development") process.env.NODE_ENV = "development";
			else process.env.MOCK_MODE = "true";
			await emit("error", "journal-test-pretty");
			expect(captured).toHaveLength(1);
			expect(captured[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}.*error/);
			expect(captured[0]).not.toMatch(/^<[0-7]>/);
		},
	);

	test("unset NODE_ENV still prefixes the JSON formatting branch", async () => {
		delete process.env.NODE_ENV;
		await emit("error", "journal-test-unset");
		expect(captured[0]).toMatch(/^<3>\{/);
	});

	test("production detail changes drop debug, retain info, then restore debug", async () => {
		logging.setJournalDetail("info");
		await emit("debug", "journal-test-dropped");
		await emit("info", "journal-test-info");
		logging.setJournalDetail("debug");
		await emit("debug", "journal-test-restored");
		expect(captured.map((line) => JSON.parse(line.slice(3)).msg)).toEqual([
			"journal-test-info",
			"journal-test-restored",
		]);
	});

	test("detail is inert outside production", () => {
		process.env.NODE_ENV = "development";
		consoleTransport.level = "warn";
		logging.setJournalDetail("debug");
		expect(consoleTransport.level).toBe("warn");
	});

	test("LOG_LEVEL wins over a runtime detail change on the console alone", async () => {
		const levels = logging.logger.transports.map(
			(transport) => transport.level,
		);
		process.env.LOG_LEVEL = "error";
		logging.setJournalDetail("debug");
		await emit("warn", "journal-test-dropped");
		await emit("error", "journal-test-error");
		expect(captured).toHaveLength(1);
		expect(captured[0]).toContain("journal-test-error");
		for (const [index, transport] of logging.logger.transports.entries()) {
			if (transport !== consoleTransport)
				expect(transport.level).toBe(levels[index]);
		}
	});
});

describe("ring subscriptions", () => {
	test("unsubscribing one listener leaves the other listener active", async () => {
		const first: number[] = [];
		const second: number[] = [];
		const start =
			logging.getLogRingOffset() + logging.getRecentLogLines().length;
		const stopFirst = logging.onLogLine((_line, seq) => first.push(seq));
		const stopSecond = logging.onLogLine((_line, seq) => second.push(seq));
		try {
			await emit("debug", "journal-test-both");
			stopFirst();
			await emit("debug", "journal-test-second");
			expect(first).toEqual([start]);
			expect(second).toEqual([start, start + 1]);
		} finally {
			stopFirst();
			stopSecond();
		}
	});

	test("eviction and clears preserve sequence, redaction and unsubscribe", async () => {
		logging.clearRecentLogLines();
		const start = logging.getLogRingOffset();
		const seen: Array<{ line: string; seq: number }> = [];
		const stop = logging.onLogLine((line, seq) => seen.push({ line, seq }));
		try {
			for (let i = 0; i <= logging.LOG_RING_CAPACITY; i++) {
				await emit("debug", `journal-test-ring-${i}`);
			}
			expect(seen).toHaveLength(logging.LOG_RING_CAPACITY + 1);
			expect(seen.map(({ seq }) => seq)).toEqual(
				Array.from(
					{ length: logging.LOG_RING_CAPACITY + 1 },
					(_, i) => start + i,
				),
			);
			expect(logging.getLogRingOffset()).toBe(start + 1);
			expect(logging.getRecentLogLines()).toEqual(
				seen.slice(1).map(({ line }) => line),
			);
			logging.clearRecentLogLines();
			expect(logging.getRecentLogLines()).toEqual([]);
			expect(logging.getLogRingOffset()).toBe(
				start + logging.LOG_RING_CAPACITY + 1,
			);
			await emit("debug", "v4.public.abc");
			expect(seen.at(-1)?.seq).toBe(start + logging.LOG_RING_CAPACITY + 1);
			expect(seen.at(-1)?.line).not.toContain("v4.public.abc");
			expect(JSON.parse(seen.at(-1)?.line ?? "")).toMatchObject({
				msg: "[REDACTED]",
			});
			stop();
			stop();
			const count = seen.length;
			await emit("debug", "journal-test-unsubscribed");
			expect(seen).toHaveLength(count);
		} finally {
			stop();
			logging.clearRecentLogLines();
		}
	});
});

test("the ring keeps exactly 1000 of 1100 records and advances by 100", async () => {
	logging.clearRecentLogLines();
	const start = logging.getLogRingOffset();
	try {
		for (let i = 0; i < 1100; i++) await emit("debug", "capacity-" + i);
		const retained = logging.getRecentLogLines();
		expect(retained).toHaveLength(1000);
		expect(JSON.parse(retained[0] ?? "").msg).toBe("capacity-100");
		expect(JSON.parse(retained[999] ?? "").msg).toBe("capacity-1099");
		expect(logging.getLogRingOffset()).toBe(start + 100);
	} finally {
		logging.clearRecentLogLines();
	}
});

test("ring and subscriber preserve non-ASCII JSON without transport terminators", async () => {
	const seen: string[] = [];
	const stop = logging.onLogLine((line) => seen.push(line));
	const message = "Espa\u00f1ol \u0639\u0631\u0628\u064a \u65e5\u672c\u8a9e";
	const module = "antena \u00f1";
	try {
		await new Promise<void>((resolve, reject) =>
			logging.logger.write({ level: "error", message, module }, (error) =>
				error ? reject(error) : resolve(),
			),
		);
		expect(seen).toHaveLength(1);
		const line = seen[0];
		assert(line);
		expect(JSON.parse(line)).toMatchObject({ msg: message, module });
		expect(line).toBe(JSON.stringify(JSON.parse(line)));
		expect(logging.getRecentLogLines().at(-1)).toBe(line);
	} finally {
		stop();
	}
});

test("a returned ring array cannot erase retained history or alter its offset", async () => {
	logging.clearRecentLogLines();
	const offset = logging.getLogRingOffset();
	try {
		await emit("debug", "copy-first");
		const copy = logging.getRecentLogLines();
		copy.length = 0;
		await emit("debug", "copy-second");
		expect(
			logging.getRecentLogLines().map((line) => JSON.parse(line).msg),
		).toEqual(["copy-first", "copy-second"]);
		expect(logging.getLogRingOffset()).toBe(offset);
	} finally {
		logging.clearRecentLogLines();
	}
});
