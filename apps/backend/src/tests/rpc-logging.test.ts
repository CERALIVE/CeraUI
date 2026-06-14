import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REDACTED } from "../helpers/logger.ts";
import {
	instrumentRpcCall,
	isRpcTraceEnabled,
	isSensitiveProcedure,
	logRpcCall,
	newCorrelationId,
	type RpcLoggingDeps,
} from "../rpc/rpc-logging.ts";

interface CapturedLine {
	message: string;
	meta: Record<string, unknown> | undefined;
}

const CID_RE = /^[0-9a-f]{8}$/;

function makeCapture(overrides: Partial<RpcLoggingDeps> = {}): {
	lines: CapturedLine[];
	deps: RpcLoggingDeps;
} {
	const lines: CapturedLine[] = [];
	const deps: RpcLoggingDeps = {
		sink: { debug: (message, meta) => lines.push({ message, meta }) },
		now: () => performance.now(),
		genCorrelationId: newCorrelationId,
		isEnabled: isRpcTraceEnabled,
		...overrides,
	};
	return { lines, deps };
}

describe("rpc-logging", () => {
	let savedNodeEnv: string | undefined;
	let savedLogLevel: string | undefined;

	beforeEach(() => {
		savedNodeEnv = process.env.NODE_ENV;
		savedLogLevel = process.env.LOG_LEVEL;
	});

	afterEach(() => {
		if (savedNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = savedNodeEnv;
		}
		if (savedLogLevel === undefined) {
			delete process.env.LOG_LEVEL;
		} else {
			process.env.LOG_LEVEL = savedLogLevel;
		}
	});

	test("newCorrelationId yields a unique 8-hex id", () => {
		const a = newCorrelationId();
		const b = newCorrelationId();
		expect(a).toMatch(CID_RE);
		expect(b).toMatch(CID_RE);
		expect(a).not.toBe(b);
	});

	test("isSensitiveProcedure flags only the auth namespace", () => {
		expect(isSensitiveProcedure(["auth", "login"])).toBe(true);
		expect(isSensitiveProcedure(["auth"])).toBe(true);
		expect(isSensitiveProcedure(["streaming", "getConfig"])).toBe(false);
		expect(isSensitiveProcedure([])).toBe(false);
	});

	test("at debug level a call emits one line with procedure+latency+ok+cid", async () => {
		process.env.LOG_LEVEL = "debug";
		const { lines, deps } = makeCapture();

		const result = await instrumentRpcCall(
			["streaming", "getConfig"],
			{ field: "value" },
			undefined,
			async () => ({ ok: true }),
			deps,
		);

		expect(result).toEqual({ ok: true });
		expect(lines).toHaveLength(1);
		const { message, meta } = lines[0]!;
		expect(message).toBe("RPC streaming.getConfig ok");
		expect(meta).toBeDefined();
		expect(meta?.procedure).toBe("streaming.getConfig");
		expect(meta?.ok).toBe(true);
		expect(typeof meta?.latency_ms).toBe("number");
		expect(meta?.latency_ms as number).toBeGreaterThanOrEqual(0);
		expect(meta?.cid as string).toMatch(CID_RE);
	});

	test("non-auth args are logged but redacted", async () => {
		process.env.LOG_LEVEL = "debug";
		const { lines, deps } = makeCapture();

		await instrumentRpcCall(
			["wifi", "connect"],
			{ ssid: "home-net", password: "hunter2" },
			undefined,
			async () => ({ success: true }),
			deps,
		);

		expect(lines).toHaveLength(1);
		const args = lines[0]?.meta?.args as Record<string, unknown>;
		expect(args.ssid).toBe("home-net");
		expect(args.password).toBe(REDACTED);
		expect(JSON.stringify(lines[0])).not.toContain("hunter2");
	});

	test("an auth call emits NO args; cid + outcome still present", async () => {
		process.env.LOG_LEVEL = "debug";
		const { lines, deps } = makeCapture();

		await instrumentRpcCall(
			["auth", "login"],
			{ password: "super-secret", token: "v4.public.abc" },
			undefined,
			async () => ({ success: true, auth_token: "v4.public.minted" }),
			deps,
		);

		expect(lines).toHaveLength(1);
		const { message, meta } = lines[0]!;
		expect(message).toBe("RPC auth.login ok");
		expect(meta?.procedure).toBe("auth.login");
		expect(meta?.ok).toBe(true);
		expect(meta?.cid as string).toMatch(CID_RE);
		// No args under ANY form — not even a redacted placeholder.
		expect(meta && "args" in meta).toBe(false);
		expect(JSON.stringify(lines[0])).not.toContain("super-secret");
		expect(JSON.stringify(lines[0])).not.toContain("v4.public");
	});

	test("a failing call logs ok:false and re-throws", async () => {
		process.env.LOG_LEVEL = "debug";
		const { lines, deps } = makeCapture();
		const boom = new Error("procedure exploded");

		await expect(
			instrumentRpcCall(
				["streaming", "start"],
				{ foo: 1 },
				undefined,
				async () => {
					throw boom;
				},
				deps,
			),
		).rejects.toThrow("procedure exploded");

		expect(lines).toHaveLength(1);
		expect(lines[0]?.message).toBe("RPC streaming.start err");
		expect(lines[0]?.meta?.ok).toBe(false);
		expect(lines[0]?.meta?.cid as string).toMatch(CID_RE);
	});

	test("client label is taken from the context when available", async () => {
		process.env.LOG_LEVEL = "debug";
		const { lines, deps } = makeCapture();

		await instrumentRpcCall(
			["status", "getStatus"],
			undefined,
			{ getSenderId: () => "sender-42" },
			async () => ({}),
			deps,
		);

		expect(lines[0]?.meta?.client).toBe("sender-42");
	});

	test("at default prod level no per-call lines are emitted", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.LOG_LEVEL;
		const { lines, deps } = makeCapture();

		const result = await instrumentRpcCall(
			["streaming", "getConfig"],
			{ field: "value" },
			undefined,
			async () => ({ ok: true }),
			deps,
		);

		expect(result).toEqual({ ok: true });
		expect(lines).toHaveLength(0);
	});

	test("logRpcCall is a no-op when the gate is closed", () => {
		process.env.NODE_ENV = "production";
		delete process.env.LOG_LEVEL;
		const { lines, deps } = makeCapture();

		logRpcCall(
			{
				path: ["streaming", "getConfig"],
				input: { field: "value" },
				ok: true,
				latencyMs: 1.2,
				cid: "deadbeef",
			},
			deps,
		);

		expect(lines).toHaveLength(0);
	});

	test("isRpcTraceEnabled honours dev and LOG_LEVEL=debug", () => {
		process.env.NODE_ENV = "production";
		delete process.env.LOG_LEVEL;
		expect(isRpcTraceEnabled()).toBe(false);

		process.env.LOG_LEVEL = "debug";
		expect(isRpcTraceEnabled()).toBe(true);

		delete process.env.LOG_LEVEL;
		process.env.NODE_ENV = "development";
		expect(isRpcTraceEnabled()).toBe(true);
	});
});
