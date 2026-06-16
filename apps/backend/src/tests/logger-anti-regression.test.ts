/*
 * Task 20 — logger anti-regression guard (consolidated end-to-end).
 *
 * The other logger suites prove the building blocks in isolation:
 *   - logger-redaction       → logRedact()/redact() scrub rules
 *   - logger-console-format  → formatConsoleEntry()/shouldColorizeConsole()
 *   - logger-prod-format     → formatProdEntry()/resolveLogLevel()
 *   - rpc-logging            → per-RPC auth-safe instrumentation
 *   - loop-visibility        → debug-gated tick/broadcast visibility
 *   - streaming-logger       → LOCKED error/warn/info/debug API (untouched here)
 *
 * This file is the SAFETY NET that wires them together against the *real*
 * `logger` singleton — not the pure serializers — so it fails if a future
 * change rewires a transport to leak ANSI into production or to drop redaction.
 * It captures each live transport's serialized line by intercepting that
 * transport's own `log()` (after its format chain has run, so `info[MESSAGE]`
 * is the exact bytes that would hit stdout / debug.log).
 *
 * Two invariants are non-negotiable:
 *   1. the production path NEVER emits an ANSI escape (journals/log shippers
 *      must parse clean JSON), and
 *   2. a known secret token NEVER survives into ANY transport's output.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { logger, REDACTED } from "../helpers/logger.ts";

const ANSI_ESCAPE = "\x1b[";
const HH_MM_SS_RE = /\d{2}:\d{2}:\d{2}\.\d{3}/;

// The single secret token threaded through every shape below. If redaction is
// ever weakened, this string surfaces verbatim in a captured line and the suite
// goes red.
const KNOWN_SECRET = "v4.public.abc";

// winston stamps the fully-serialized line onto the info object under this
// symbol after the transport's format chain runs.
const WINSTON_MESSAGE = Symbol.for("message");

interface CapturedLine {
	transport: string;
	line: string;
}

// Minimal shape we need off each live transport — avoids importing
// winston-transport (its .d.ts is not installed; see notepad Task 11 flake).
interface CapturableTransport {
	constructor: { name: string };
	log?: (info: Record<symbol, unknown>, next: () => void) => void;
}

// winston delivers to a transport on a later tick — settle before asserting.
const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 25));

/**
 * Run `emit` with every live transport's `log()` replaced by a capturing stub
 * that records the post-format serialized line and swallows the write (no real
 * stdout noise, no debug.log churn). Restores the originals afterwards.
 */
async function captureTransports(emit: () => void): Promise<CapturedLine[]> {
	const captured: CapturedLine[] = [];
	const restores: Array<() => void> = [];

	for (const transport of logger.transports as unknown as CapturableTransport[]) {
		const name = transport.constructor.name;
		const original = transport.log;
		transport.log = (info: Record<symbol, unknown>, next: () => void) => {
			captured.push({ transport: name, line: String(info[WINSTON_MESSAGE]) });
			next();
		};
		restores.push(() => {
			transport.log = original;
		});
	}

	try {
		emit();
		await flush();
	} finally {
		for (const restore of restores) {
			restore();
		}
	}

	return captured;
}

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedIsTty: boolean | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedIsTty = process.stdout.isTTY;
});

afterEach(() => {
	if (savedNodeEnv === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = savedNodeEnv;
	}
	if (savedMockMode === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = savedMockMode;
	}
	process.stdout.isTTY = savedIsTty as boolean;
});

function forceProd(): void {
	delete process.env.NODE_ENV;
	delete process.env.MOCK_MODE;
	process.stdout.isTTY = true; // even on a TTY, prod must not colorize
}

function forceDevTty(): void {
	process.env.NODE_ENV = "development";
	delete process.env.MOCK_MODE;
	process.stdout.isTTY = true;
}

// `error` clears every transport level gate (console default warn, file debug),
// so both transports always serialize the record under test.
const emitWithSecret = () =>
	logger.error("login attempt", {
		module: "auth",
		token: KNOWN_SECRET,
		header: `Bearer ${KNOWN_SECRET}.signature`,
		nested: { password: "hunter2", inner: { auth_token: KNOWN_SECRET } },
	});

describe("logger anti-regression — no ANSI in the production path", () => {
	test("every live transport's prod-mode line is free of ANSI escapes", async () => {
		forceProd();
		const lines = await captureTransports(() =>
			logger.error("stream stalled", { module: "streaming", links: 3 }),
		);

		expect(lines.length).toBeGreaterThan(0);
		for (const { transport, line } of lines) {
			expect(line, `${transport} leaked an ANSI escape in prod`).not.toContain(
				ANSI_ESCAPE,
			);
		}
	});

	test("the prod console line is valid JSON on the fixed schema (no pretty text)", async () => {
		forceProd();
		const lines = await captureTransports(() =>
			logger.error("boom", { module: "modems", code: 7 }),
		);

		const console = lines.find((l) => l.transport === "Console");
		expect(console).toBeDefined();
		const parsed = JSON.parse(console!.line) as {
			level: string;
			msg: string;
			module?: string;
			meta?: Record<string, unknown>;
		};
		expect(parsed.level).toBe("error");
		expect(parsed.msg).toBe("boom");
		expect(parsed.module).toBe("modems");
		expect(parsed.meta).toEqual({ code: 7 });
	});

	test("the file transport is JSON even in dev mode (only the console goes pretty)", async () => {
		forceDevTty();
		const lines = await captureTransports(() =>
			logger.error("disk event", { module: "system" }),
		);

		const file = lines.find((l) => l.transport === "File");
		expect(file).toBeDefined();
		expect(file!.line).not.toContain(ANSI_ESCAPE);
		expect(() => JSON.parse(file!.line)).not.toThrow();
	});
});

describe("logger anti-regression — secrets never reach any transport", () => {
	test("the known token is absent from EVERY transport line in prod", async () => {
		forceProd();
		const lines = await captureTransports(emitWithSecret);

		expect(lines.length).toBeGreaterThan(0);
		for (const { transport, line } of lines) {
			expect(line, `${transport} leaked the secret token`).not.toContain(
				KNOWN_SECRET,
			);
			expect(line).not.toContain("hunter2");
			expect(line).toContain(REDACTED);
		}
	});

	test("the known token is absent even from the colorized dev console line", async () => {
		forceDevTty();
		const lines = await captureTransports(emitWithSecret);

		const console = lines.find((l) => l.transport === "Console");
		expect(console).toBeDefined();
		// dev + TTY → the line is colorized (proves we are on the pretty branch)…
		expect(console!.line).toContain(ANSI_ESCAPE);
		// …yet redaction still runs ahead of formatting.
		expect(console!.line).not.toContain(KNOWN_SECRET);
		expect(console!.line).not.toContain("hunter2");
	});

	test("deeply nested secret-shaped values and sensitive keys are scrubbed in the prod record", async () => {
		forceProd();
		const lines = await captureTransports(emitWithSecret);

		const file = lines.find((l) => l.transport === "File");
		expect(file).toBeDefined();
		const parsed = JSON.parse(file!.line) as {
			meta: {
				token: string;
				header: string;
				nested: {
					password: string;
					inner: { auth_token: string };
				};
			};
		};

		expect(parsed.meta.token).toBe(REDACTED); // sensitive KEY
		expect(parsed.meta.header).toBe(REDACTED); // secret-shaped VALUE (bearer)
		expect(parsed.meta.nested.password).toBe(REDACTED); // nested KEY
		expect(parsed.meta.nested.inner.auth_token).toBe(REDACTED); // 3-level KEY
	});
});

describe("logger anti-regression — dev/prod format selection through the live logger", () => {
	test("dev + TTY console line is the pretty HH:MM:SS form with an ANSI badge", async () => {
		forceDevTty();
		const lines = await captureTransports(() =>
			logger.error("started", { module: "streaming" }),
		);

		const console = lines.find((l) => l.transport === "Console");
		expect(console).toBeDefined();
		expect(console!.line).toContain(ANSI_ESCAPE);
		expect(console!.line).toMatch(HH_MM_SS_RE);
		// pretty form is NOT JSON
		expect(() => JSON.parse(console!.line)).toThrow();
	});

	test("prod console line is the JSON schema form, never the pretty form", async () => {
		forceProd();
		const lines = await captureTransports(() =>
			logger.error("started", { module: "streaming" }),
		);

		const console = lines.find((l) => l.transport === "Console");
		expect(console).toBeDefined();
		expect(console!.line).not.toContain(ANSI_ESCAPE);
		// JSON form carries the ISO `ts`, not a bare HH:MM:SS clock token.
		const parsed = JSON.parse(console!.line) as { ts: string };
		expect(Number.isNaN(new Date(parsed.ts).getTime())).toBe(false);
	});
});
