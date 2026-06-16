import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import winston from "winston";

import {
	formatProdEntry,
	REDACTED,
	redact,
	resolveLogLevel,
	type StructuredLogInfo,
} from "../helpers/logger.ts";

const ANSI_ESCAPE = "\x1b[";
const WINSTON_MESSAGE = Symbol.for("message");

// Mirror the production transport's format chain (structuredBase + the prod
// serializer) so the test exercises real redaction → schema mapping, not a
// stubbed shortcut.
const prodChain = winston.format.combine(
	winston.format.timestamp(),
	redact(),
	winston.format.printf((info) => formatProdEntry(info as StructuredLogInfo)),
);

function renderProd(
	input: { level: string; message: string } & Record<string, unknown>,
): string {
	const info = prodChain.transform({ ...input }) as
		| Record<symbol, unknown>
		| false;
	if (info === false) {
		throw new Error("format chain dropped the record");
	}
	return String(info[WINSTON_MESSAGE]);
}

interface ParsedRecord {
	ts: string;
	level: string;
	msg: string;
	module?: string;
	meta?: Record<string, unknown>;
}

describe("production log schema", () => {
	test("record is valid JSON limited to the fixed field set", () => {
		const line = formatProdEntry({ level: "warn", message: "stream stalled" });
		const parsed = JSON.parse(line) as ParsedRecord;

		expect(Object.keys(parsed).sort()).toEqual(["level", "msg", "ts"]);
		expect(parsed.level).toBe("warn");
		expect(parsed.msg).toBe("stream stalled");
		expect(typeof parsed.ts).toBe("string");
		expect(Number.isNaN(new Date(parsed.ts).getTime())).toBe(false);
	});

	test("module is promoted to a top-level field, never duplicated in meta", () => {
		const line = formatProdEntry({
			level: "info",
			message: "tick",
			module: "streaming",
			links: 3,
		});
		const parsed = JSON.parse(line) as ParsedRecord;

		expect(parsed.module).toBe("streaming");
		expect(parsed.meta).toEqual({ links: 3 });
		expect(parsed.meta).not.toHaveProperty("module");
	});

	test("prod output carries no ANSI escape", () => {
		const line = renderProd({
			level: "error",
			message: "boom",
			module: "modems",
			detail: { code: 7 },
		});

		expect(line).not.toContain(ANSI_ESCAPE);
		expect(() => JSON.parse(line)).not.toThrow();
	});

	test("secrets are redacted in the prod record (key + value shaped)", () => {
		const line = renderProd({
			level: "warn",
			message: "login attempt",
			token: "v4.public.abcDEF123",
			nested: { password: "hunter2" },
			note: "Bearer abc123XYZ.tok",
		});
		const parsed = JSON.parse(line) as ParsedRecord & {
			meta: {
				token: string;
				nested: { password: string };
				note: string;
			};
		};

		expect(parsed.meta.token).toBe(REDACTED);
		expect(parsed.meta.nested.password).toBe(REDACTED);
		expect(parsed.meta.note).toBe(REDACTED);
		expect(line).not.toContain("hunter2");
		expect(line).not.toContain("v4.public.abcDEF123");
	});

	test("Error metadata is surfaced as name/message/stack, not flattened to {}", () => {
		const line = formatProdEntry({
			level: "error",
			message: "save failed",
			err: new Error("disk full"),
		});
		const parsed = JSON.parse(line) as ParsedRecord & {
			meta: { err: { name: string; message: string } };
		};

		expect(parsed.meta.err.message).toBe("disk full");
		expect(parsed.meta.err.name).toBe("Error");
	});
});

describe("LOG_LEVEL gating", () => {
	let savedLogLevel: string | undefined;

	beforeEach(() => {
		savedLogLevel = process.env.LOG_LEVEL;
	});

	afterEach(() => {
		if (savedLogLevel === undefined) {
			delete process.env.LOG_LEVEL;
		} else {
			process.env.LOG_LEVEL = savedLogLevel;
		}
	});

	test("defaults are unchanged when LOG_LEVEL is unset", () => {
		delete process.env.LOG_LEVEL;

		expect(resolveLogLevel("info")).toBe("info");
		expect(resolveLogLevel("warn")).toBe("warn");
		expect(resolveLogLevel("debug")).toBe("debug");
	});

	test("LOG_LEVEL overrides every transport default when set", () => {
		process.env.LOG_LEVEL = "error";

		expect(resolveLogLevel("info")).toBe("error");
		expect(resolveLogLevel("warn")).toBe("error");
		expect(resolveLogLevel("debug")).toBe("error");
	});

	test("blank LOG_LEVEL falls back to the default", () => {
		process.env.LOG_LEVEL = "   ";

		expect(resolveLogLevel("warn")).toBe("warn");
	});
});
