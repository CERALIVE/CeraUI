/**
 * Start-failure taxonomy mapping tests (device-quality-wave2 Todo 25).
 *
 * Table-driven proof that EVERY known start-path failure site maps to exactly
 * one taxonomy class + phase, that an unmapped/opaque error shape falls to
 * `engine_internal` + a logged warning and NEVER throws, and that the
 * attempt-id generator, retry policy, and suppression-window predicate behave
 * as designed. Design-only: nothing here is imported by a runtime path yet
 * (that is Todos 26-29).
 */

import { describe, expect, test } from "bun:test";

import {
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
} from "@ceralive/cerastream";

import {
	classifyStartFailure,
	newAttemptId,
	nextBackoffDelayMs,
	shouldRetryStart,
	shouldSuppressTransientFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";

// A ZodError-shaped object without importing zod's class directly — the
// classifier recognizes it structurally (name === "ZodError"), mirroring the
// existing `isZodLikeError` in cerastream-backend.ts.
function zodLikeError(): Error {
	const err = new Error("Invalid config: srt_latency - too small");
	err.name = "ZodError";
	return err;
}

describe("classifyStartFailure — table over every known failure site", () => {
	const cases: Array<{
		name: string;
		phase: Parameters<typeof classifyStartFailure>[0];
		error: unknown;
		expectClass: string;
		expectRetriable: boolean;
		expectCode?: number | string;
	}> = [
		// ── params phase (zod / plain validation) ────────────────────────────
		{
			name: "oRPC/CeraUI zod parse failure → start_invalid",
			phase: "params",
			error: zodLikeError(),
			expectClass: "start_invalid",
			expectRetriable: false,
		},
		{
			name: "plain Error from validateConfig → start_invalid",
			phase: "params",
			error: new Error("Invalid audio delay"),
			expectClass: "start_invalid",
			expectRetriable: false,
		},
		// ── connect phase (ENOENT / ECONNREFUSED wrapped) ────────────────────
		{
			name: "connect ENOENT (engine socket absent) → engine_unavailable, retriable",
			phase: "connect",
			error: new CerastreamConnectionError(
				"failed to connect to cerastream control socket at /run/cerastream/control.sock",
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			),
			expectClass: "engine_unavailable",
			expectRetriable: true,
		},
		{
			name: "connect ECONNREFUSED (engine down) → engine_unavailable, retriable",
			phase: "connect",
			error: new CerastreamConnectionError(
				"failed to connect",
				Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
			),
			expectClass: "engine_unavailable",
			expectRetriable: true,
		},
		{
			name: "connect timeout → start_timeout, retriable (connect phase)",
			phase: "connect",
			error: new CerastreamTimeoutError("connect", 10_000),
			expectClass: "start_timeout",
			expectRetriable: true,
		},
		// ── hello phase ──────────────────────────────────────────────────────
		{
			name: "hello protocol-major mismatch (-32000) → protocol_incompatible",
			phase: "hello",
			error: new CerastreamRpcError(
				-32000,
				"unsupported protocol version",
				"cerastream.protocol.unsupported_version",
			),
			expectClass: "protocol_incompatible",
			expectRetriable: false,
			expectCode: -32000,
		},
		{
			name: "hello result-shape ZodError → protocol_incompatible",
			phase: "hello",
			error: zodLikeError(),
			expectClass: "protocol_incompatible",
			expectRetriable: false,
		},
		{
			name: "hello connection lost → engine_unavailable, retriable",
			phase: "hello",
			error: new CerastreamConnectionError("control connection is not open"),
			expectClass: "engine_unavailable",
			expectRetriable: true,
		},
		{
			name: "hello timeout → start_timeout, NOT retriable (post-connect)",
			phase: "hello",
			error: new CerastreamTimeoutError("hello", 10_000),
			expectClass: "start_timeout",
			expectRetriable: false,
		},
		// ── subscribe phase ──────────────────────────────────────────────────
		{
			name: "subscribe timeout → start_timeout, NOT retriable (post-connect)",
			phase: "subscribe",
			error: new CerastreamTimeoutError("subscribe-events", 10_000),
			expectClass: "start_timeout",
			expectRetriable: false,
		},
		{
			name: "subscribe connection lost → engine_unavailable, NOT retriable (post-connect)",
			phase: "subscribe",
			error: new CerastreamConnectionError("control connection is not open"),
			expectClass: "engine_unavailable",
			expectRetriable: false,
		},
		// ── start-rpc phase (JSON-RPC codes) ─────────────────────────────────
		{
			name: "start-rpc -32602 params.invalid → start_invalid",
			phase: "start-rpc",
			error: new CerastreamRpcError(
				-32602,
				"invalid params",
				"cerastream.params.invalid",
			),
			expectClass: "start_invalid",
			expectRetriable: false,
			expectCode: -32602,
		},
		{
			name: "start-rpc -32002 already_streaming → engine_internal",
			phase: "start-rpc",
			error: new CerastreamRpcError(
				-32002,
				"already streaming",
				"cerastream.state.already_streaming",
			),
			expectClass: "engine_internal",
			expectRetriable: false,
			expectCode: -32002,
		},
		{
			name: "start-rpc -32003 device.not_found → start_invalid",
			phase: "start-rpc",
			error: new CerastreamRpcError(
				-32003,
				"device not found",
				"cerastream.device.not_found",
			),
			expectClass: "start_invalid",
			expectRetriable: false,
			expectCode: -32003,
		},
		{
			name: "start-rpc -32603 internal → engine_internal",
			phase: "start-rpc",
			error: new CerastreamRpcError(-32603, "internal", "cerastream.internal"),
			expectClass: "engine_internal",
			expectRetriable: false,
			expectCode: -32603,
		},
		{
			name: "start-rpc request timeout → start_timeout, NOT retriable (post-connect)",
			phase: "start-rpc",
			error: new CerastreamTimeoutError("start", 10_000),
			expectClass: "start_timeout",
			expectRetriable: false,
		},
		// ── playing-wait phase ───────────────────────────────────────────────
		{
			name: "playing-wait timeout → start_timeout, NOT retriable (post-connect)",
			phase: "playing-wait",
			error: new CerastreamTimeoutError("start", 10_000),
			expectClass: "start_timeout",
			expectRetriable: false,
		},
	];

	for (const c of cases) {
		test(c.name, () => {
			const failure = classifyStartFailure(c.phase, c.error, "att_test");
			expect(failure.phase).toBe(c.phase);
			expect(failure.class).toBe(c.expectClass);
			expect(failure.retriable).toBe(c.expectRetriable);
			expect(failure.attemptId).toBe("att_test");
			if (c.expectCode !== undefined) {
				expect(failure.code).toBe(c.expectCode);
			}
		});
	}

	test("an unmapped/opaque error falls to engine_internal + a logged warning, never throws", () => {
		const warnings: string[] = [];
		const failure = classifyStartFailure(
			"start-rpc",
			{ weird: true },
			"att_x",
			{
				warn: (m) => warnings.push(m),
			},
		);
		expect(failure.class).toBe("engine_internal");
		expect(failure.retriable).toBe(false);
		expect(warnings.length).toBe(1);
	});

	test("an engine RPC code outside the known table falls to engine_internal", () => {
		const failure = classifyStartFailure(
			"start-rpc",
			new CerastreamRpcError(-32099, "novel", "cerastream.future.code"),
			"att_y",
		);
		expect(failure.class).toBe("engine_internal");
	});
});

describe("newAttemptId — unique, prefixed, boundary-generated", () => {
	test("is prefixed and unique across calls", () => {
		const a = newAttemptId();
		const b = newAttemptId();
		expect(a.startsWith("att_")).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe("retry policy — bounded exponential backoff, retriable classes only", () => {
	test("backoff grows exponentially then caps", () => {
		const d0 = nextBackoffDelayMs(0);
		const d1 = nextBackoffDelayMs(1);
		const d2 = nextBackoffDelayMs(2);
		expect(d1).toBeGreaterThanOrEqual(d0);
		expect(d2).toBeGreaterThanOrEqual(d1);
		expect(nextBackoffDelayMs(50)).toBeLessThanOrEqual(
			nextBackoffDelayMs(51) + 1,
		);
	});

	test("a retriable connect failure retries within budget", () => {
		const failure = classifyStartFailure(
			"connect",
			new CerastreamConnectionError("down"),
			"att_r",
		);
		expect(shouldRetryStart(failure, { attempts: 1, elapsedMs: 1000 })).toBe(
			true,
		);
	});

	test("a non-retriable failure never retries", () => {
		const failure = classifyStartFailure(
			"start-rpc",
			new CerastreamRpcError(-32602, "bad", "cerastream.params.invalid"),
			"att_r",
		);
		expect(shouldRetryStart(failure, { attempts: 1, elapsedMs: 100 })).toBe(
			false,
		);
	});

	test("a retriable failure stops once max attempts is exhausted", () => {
		const failure = classifyStartFailure(
			"connect",
			new CerastreamConnectionError("down"),
			"att_r",
		);
		expect(shouldRetryStart(failure, { attempts: 99, elapsedMs: 100 })).toBe(
			false,
		);
	});

	test("a retriable failure stops once the total time budget is exhausted", () => {
		const failure = classifyStartFailure(
			"connect",
			new CerastreamConnectionError("down"),
			"att_r",
		);
		expect(
			shouldRetryStart(failure, { attempts: 1, elapsedMs: 10_000_000 }),
		).toBe(false);
	});
});

describe("suppression window — sourced from existing signals", () => {
	test("no active window → do not suppress (a real failure surfaces)", () => {
		expect(
			shouldSuppressTransientFailure({
				softwareUpdateActive: false,
				engineRestartWindow: false,
				bootWindow: false,
				cancelledByStop: false,
			}),
		).toBe(false);
	});

	test("software-update active suppresses a transient failure", () => {
		expect(
			shouldSuppressTransientFailure({
				softwareUpdateActive: true,
				engineRestartWindow: false,
				bootWindow: false,
				cancelledByStop: false,
			}),
		).toBe(true);
	});

	test("known engine-restart window suppresses", () => {
		expect(
			shouldSuppressTransientFailure({
				softwareUpdateActive: false,
				engineRestartWindow: true,
				bootWindow: false,
				cancelledByStop: false,
			}),
		).toBe(true);
	});

	test("boot window suppresses", () => {
		expect(
			shouldSuppressTransientFailure({
				softwareUpdateActive: false,
				engineRestartWindow: false,
				bootWindow: true,
				cancelledByStop: false,
			}),
		).toBe(true);
	});

	test("cancelled-by-stop suppresses (the attempt notifies nothing)", () => {
		expect(
			shouldSuppressTransientFailure({
				softwareUpdateActive: false,
				engineRestartWindow: false,
				bootWindow: false,
				cancelledByStop: true,
			}),
		).toBe(true);
	});
});
