/*
 * T3 — oRPC↔WS adapter error diagnostics.
 *
 * Proves the adapter turns opaque handler failures into traceable, structured
 * log records: the procedure path, the Zod field paths that failed, and which
 * phase (input vs output) the validation broke in — and that a non-oRPC frame
 * is reported by shape (keys + byte count), never by dumping the raw object.
 *
 * Phase distinction is derived from oRPC's own wrapper: a failed INPUT schema
 * surfaces as ORPCError `BAD_REQUEST` / "Input validation failed", a failed
 * OUTPUT schema as `INTERNAL_SERVER_ERROR` / "Output validation failed". We feed
 * the adapter REAL oRPC errors (built by running `call()` through a tiny router)
 * rather than hand-mocked shapes, so the suite tracks the library, not a guess.
 *
 * Security invariant: no secret-shaped value ever survives into a log record —
 * the frame `preview` and every issue `message` pass through `logRedact`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { os } from "@orpc/server";
import { z } from "zod";

import { logger, REDACTED } from "../helpers/logger.ts";
import { handleORPCMessage, parseMessage } from "../rpc/adapter.ts";
import { extractValidationDetails } from "../rpc/error-enrichment.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KNOWN_SECRET = "v4.public.shouldNeverSurface";

interface CapturedLog {
	level: "warn" | "error";
	message: string;
	meta: Record<string, unknown> | undefined;
}

/** Replace logger.warn/error with capturing stubs; returns captured + restore. */
function captureLogger(): { logs: CapturedLog[]; restore: () => void } {
	const logs: CapturedLog[] = [];
	const origWarn = logger.warn.bind(logger);
	const origError = logger.error.bind(logger);
	// winston-native call shape in the adapter: logger.LEVEL(message, meta).
	logger.warn = ((message: unknown, meta?: unknown) => {
		logs.push({
			level: "warn",
			message: String(message),
			meta: meta as Record<string, unknown> | undefined,
		});
		return logger;
	}) as typeof logger.warn;
	logger.error = ((message: unknown, meta?: unknown) => {
		logs.push({
			level: "error",
			message: String(message),
			meta: meta as Record<string, unknown> | undefined,
		});
		return logger;
	}) as typeof logger.error;
	return {
		logs,
		restore: () => {
			logger.warn = origWarn;
			logger.error = origError;
		},
	};
}

/** Minimal Bun ServerWebSocket stand-in: just what the adapter touches. */
function fakeWs(): AppWebSocket {
	const sent: string[] = [];
	const ws = {
		remoteAddress: "203.0.113.7",
		data: {
			isAuthenticated: true,
			lastActive: Date.now(),
			senderId: "sender-7",
		},
		send: (payload: string) => {
			sent.push(payload);
			return payload.length;
		},
		__sent: sent,
	};
	return ws as unknown as AppWebSocket;
}

// Tiny router with no auth gate: one procedure that fails INPUT validation, one
// that fails OUTPUT validation (handler returns a value its schema rejects).
const base = os.$context<RPCContext>();
const testRouter = os.$context<RPCContext>().router({
	probe: os.router({
		inputFail: base
			.input(z.object({ count: z.number() }))
			.output(z.object({ ok: z.boolean() }))
			.handler(() => ({ ok: true })),
		outputFail: base
			.input(z.object({ note: z.string() }))
			.output(z.object({ count: z.number() }))
			.handler(
				() => ({ count: "not-a-number" }) as unknown as { count: number },
			),
	}),
});

describe("adapter diagnostics", () => {
	let cap: ReturnType<typeof captureLogger>;
	let savedNodeEnv: string | undefined;

	beforeEach(() => {
		savedNodeEnv = process.env.NODE_ENV;
		cap = captureLogger();
	});

	afterEach(() => {
		cap.restore();
		if (savedNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = savedNodeEnv;
		}
	});

	test("(1) OUTPUT validation failure logs procedure + issue path + phase:output", async () => {
		await handleORPCMessage(
			fakeWs(),
			{ id: "m1", path: ["probe", "outputFail"], input: { note: "hi" } },
			testRouter,
		);

		const errLog = cap.logs.find((l) => l.level === "error");
		expect(errLog).toBeDefined();
		expect(errLog?.meta?.procedure).toBe("probe.outputFail");
		const validation = errLog?.meta?.validation as {
			phase: string;
			issues: { path: string; message: string; code: string }[];
		};
		expect(validation).toBeDefined();
		expect(validation.phase).toBe("output");
		expect(validation.issues.length).toBeGreaterThan(0);
		expect(validation.issues.map((i) => i.path)).toContain("count");
	});

	test("(2) INPUT validation failure logs procedure + issue path + phase:input", async () => {
		await handleORPCMessage(
			fakeWs(),
			// count must be a number; secret-shaped value must never leak
			{
				id: "m2",
				path: ["probe", "inputFail"],
				input: { count: KNOWN_SECRET },
			},
			testRouter,
		);

		const errLog = cap.logs.find((l) => l.level === "error");
		expect(errLog).toBeDefined();
		expect(errLog?.meta?.procedure).toBe("probe.inputFail");
		const validation = errLog?.meta?.validation as {
			phase: string;
			issues: { path: string; message: string; code: string }[];
		};
		expect(validation).toBeDefined();
		expect(validation.phase).toBe("input");
		expect(validation.issues.map((i) => i.path)).toContain("count");
		// No secret survives into the validation record (input values not logged).
		expect(JSON.stringify(errLog)).not.toContain(KNOWN_SECRET);
	});

	test("(3) non-oRPC frame logs keys + bytes, not the raw object", () => {
		const frame = JSON.stringify({ foo: "bar", id: "x1", token: KNOWN_SECRET });
		const result = parseMessage(frame, fakeWs());

		expect(result).toBeNull();
		const warnLog = cap.logs.find((l) => l.level === "warn");
		expect(warnLog).toBeDefined();
		expect(warnLog?.meta?.keys).toEqual(["foo", "id", "token"]);
		expect(warnLog?.meta?.bytes).toBe(frame.length);
		expect(warnLog?.meta?.hasId).toBe(true);
		// Raw secret-bearing value must not be dumped; preview is redacted.
		expect(warnLog?.meta?.preview).toBe(REDACTED);
		expect(JSON.stringify(warnLog)).not.toContain(KNOWN_SECRET);
	});

	test("(4) heartbeat pong frame is allow-listed silently, never warned", () => {
		const result = parseMessage(JSON.stringify({ pong: true }), fakeWs());

		expect(result).toBeNull();
		expect(cap.logs.find((l) => l.level === "warn")).toBeUndefined();
	});

	test("extractValidationDetails returns undefined for a non-validation error", () => {
		expect(extractValidationDetails(new Error("plain boom"))).toBeUndefined();
		expect(extractValidationDetails("just a string")).toBeUndefined();
	});
});
