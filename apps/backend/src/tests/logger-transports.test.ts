import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import winston from "winston";
import * as logging from "../helpers/logger.ts";

const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
	LOG_LEVEL: process.env.LOG_LEVEL,
};
beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.LOG_LEVEL;
});
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("journal transport configuration", () => {
	test("a fresh production logger starts at debug without creating debug.log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "journal-startup-"));
		try {
			const child = Bun.spawn(
				[
					"bun",
					"--eval",
					`import { logger } from ${JSON.stringify(import.meta.resolve("../helpers/logger.ts"))};
					console.log(JSON.stringify(logger.transports.map(t => ({ name: t.constructor.name, level: t.level }))));
					logger.close();`,
				],
				{
					cwd: dir,
					env: process.env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = new Response(child.stdout).text();
			const errors = new Response(child.stderr).text();
			expect(await child.exited, await errors).toBe(0);
			expect(JSON.parse(await output)).toEqual([
				{ name: "Stream", level: "debug" },
				{ name: "Console", level: "debug" },
			]);
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.each([
		["production", "debug", false],
		["development", "info", true],
		["test", "warn", true],
		[undefined, "warn", true],
	] as const)(
		"%s keeps the required transports and levels",
		(env, level, file) => {
			const transports = logging.buildLoggerTransports(
				env === undefined ? {} : { NODE_ENV: env },
			);
			try {
				expect(
					transports.map((transport) => transport.constructor.name),
				).toEqual(file ? ["Stream", "Console", "File"] : ["Stream", "Console"]);
				expect(
					transports.find((t) => t instanceof winston.transports.Console)
						?.level,
				).toBe(level);
				expect(
					transports.some((t) => "filename" in t && t.filename === "debug.log"),
				).toBe(file);
				const disk = transports.find(
					(t) => t instanceof winston.transports.File,
				);
				if (file) {
					expect(disk).toMatchObject({
						filename: "debug.log",
						level: "debug",
						maxsize: 10 * 1024 * 1024,
						maxFiles: 5,
						tailable: true,
					});
				}
			} finally {
				for (const transport of transports) transport.close?.();
			}
		},
	);

	test("LOG_LEVEL overrides production console and ring defaults", () => {
		process.env.LOG_LEVEL = " error ";
		const transports = logging.buildLoggerTransports({
			NODE_ENV: "production",
		});
		expect(transports.map((transport) => transport.level)).toEqual([
			"error",
			"error",
		]);
		for (const transport of transports) transport.close?.();
	});
});

for (const nodeEnv of [
	"production",
	"development",
	"test",
	undefined,
] as const) {
	test.each([
		[" error ", "error"],
		["debug", "debug"],
		["not-a-level", "not-a-level"],
		["", null],
		["   ", null],
	] as const)(
		"LOG_LEVEL=%s controls every transport with NODE_ENV=" + String(nodeEnv),
		(override, expected) => {
			process.env.LOG_LEVEL = override;
			const transports = logging.buildLoggerTransports(
				nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv },
			);
			const defaults =
				nodeEnv === "production"
					? ["debug", "debug"]
					: nodeEnv === "development"
						? ["debug", "info", "debug"]
						: ["debug", "warn", "debug"];
			try {
				expect(transports.map((t) => t.level)).toEqual(
					expected === null ? defaults : defaults.map(() => expected),
				);
			} finally {
				for (const transport of transports) transport.close?.();
			}
		},
	);
}

test.each([
	["", "info"],
	["   ", "info"],
	["x", "x"],
	[" x ", "x"],
	["xy", "xy"],
] as const)(
	"LOG_LEVEL length boundary '%s' retains the nonblank override",
	(override, expected) => {
		process.env.LOG_LEVEL = override;
		expect(logging.resolveLogLevel("info")).toBe(expected);
	},
);

test.each(["development", "test", undefined])(
	"detail is inert for every transport outside production: %s",
	(env) => {
		if (env === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = env;
		process.env.LOG_LEVEL = "error";
		const before = logging.logger.transports.map((t) => t.level);
		try {
			logging.setJournalDetail("info");
			expect(logging.logger.transports.map((t) => t.level)).toEqual(before);
			logging.setJournalDetail("debug");
			expect(logging.logger.transports.map((t) => t.level)).toEqual(before);
		} finally {
			for (const [i, transport] of logging.logger.transports.entries()) {
				const level = before[i];
				if (level === undefined) delete transport.level;
				else transport.level = level;
			}
		}
	},
);

test.each([
	[" warn ", "warn"],
	["invalid-level", "invalid-level"],
	["", "info"],
	["   ", "info"],
] as const)("production detail resolves LOG_LEVEL=%s", (override, expected) => {
	process.env.NODE_ENV = "production";
	process.env.LOG_LEVEL = override;
	const before = logging.logger.transports.map((t) => t.level);
	try {
		logging.setJournalDetail("info");
		expect(
			logging.logger.transports.find(
				(t) => t instanceof winston.transports.Console,
			)?.level,
		).toBe(expected);
	} finally {
		for (const [i, transport] of logging.logger.transports.entries()) {
			const level = before[i];
			if (level === undefined) delete transport.level;
			else transport.level = level;
		}
	}
});
