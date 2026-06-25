import { Writable } from "node:stream";
import winston from "winston";

import { isDevelopment } from "../mocks/mock-config.ts";

const isDev = process.env.NODE_ENV === "development";

/**
 * Bounded on-disk log retention.
 *
 * Rotation caps total disk use so an SBC's eMMC/SD never fills from logs:
 *   LOG_MAX_SIZE_BYTES per file × LOG_MAX_FILES = LOG_MAX_TOTAL_BYTES ceiling.
 * `tailable: true` keeps the active file at `debug.log` and ages older segments
 * to `debug1.log`…`debug{N}.log`, dropping the oldest past the count. These are
 * named constants — never inline the literals (mirrors heartbeat.ts convention).
 */
export const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const LOG_MAX_FILES = 5; // keep at most 5 segments
export const LOG_MAX_TOTAL_BYTES = LOG_MAX_SIZE_BYTES * LOG_MAX_FILES; // 50 MB ceiling
export const LOG_FILENAME = "debug.log";

/** Marker substituted for any value scrubbed by {@link redact}. */
export const REDACTED = "[REDACTED]";

/**
 * Keys whose VALUE is always a secret regardless of content. Matched
 * case-insensitively as a substring (e.g. `simPin`, `auth_token`, `bcrp_key`,
 * `passwordHash` all match). Centralised here so every transport and all 296
 * call sites are covered by one rule.
 */
const SENSITIVE_KEY_RE = /pin|password|token|secret|paseto|bcrp|auth/i;

/**
 * Value-shaped secrets that can appear under an innocent-looking key (or inside
 * a free-text message): PASETO tokens (`v4.public.*` / `v4.local.*`) and
 * bearer/JWT-like credentials. A JWT is anchored on its mandatory `eyJ` header
 * prefix so ordinary dotted strings (hostnames, versions) are NOT over-redacted.
 */
const PASETO_RE = /v[0-9]+\.(?:public|local)\.[A-Za-z0-9\-_]+/;
const JWT_RE = /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i;

function looksSecret(value: string): boolean {
	return PASETO_RE.test(value) || JWT_RE.test(value) || BEARER_RE.test(value);
}

// Only literal `{}`-shaped objects are walked; Error and other class instances
// pass through untouched so structured-error logging keeps their fields.
function isRedactablePlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep-scrub a single value: drop secret-shaped strings, recurse into arrays
 * and plain objects (redacting sensitive KEYS along the way), and pass
 * everything else through untouched. Non-plain objects (e.g. `Error`) are left
 * intact so structured-error logging keeps working.
 */
function redactValue(value: unknown): unknown {
	if (typeof value === "string") {
		return looksSecret(value) ? REDACTED : value;
	}
	if (Array.isArray(value)) {
		return value.map(redactValue);
	}
	if (isRedactablePlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactValue(inner);
		}
		return out;
	}
	return value;
}

/** Public helper: returns a redacted clone for call sites building metadata. */
export function logRedact(value: unknown): unknown {
	return redactValue(value);
}

/**
 * Winston custom format that scrubs secrets from EVERY record before it reaches
 * any transport (console and file alike), so neither stdout nor `debug.log`
 * leaks a PIN, password, token, PASETO, bcrp key, or bearer/JWT credential.
 *
 * The info object is mutated IN PLACE (its `level`/`message`/`splat` Symbols
 * must survive) — only the enumerable string fields (the message and merged
 * metadata) are rewritten.
 */
export const redact = winston.format((info) => {
	for (const key of Object.keys(info)) {
		info[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactValue(info[key]);
	}
	return info;
});

// Shared base in BOTH transport formats so a per-transport serializer can never
// bypass the redact() scrub.
const structuredBase = winston.format.combine(
	winston.format.timestamp(),
	redact(),
);

// Raw ANSI (not chalk/picocolors): zero runtime dep, nothing to break under
// `bun build --compile`. Emitted only when shouldColorizeConsole() is true, so
// CI/piped/production output stays clean 7-bit ASCII.
const ANSI = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	green: "\x1b[32m",
	dim: "\x1b[2m",
} as const;

const LEVEL_ANSI: Record<string, string> = {
	error: ANSI.red,
	warn: ANSI.yellow,
	info: ANSI.green,
	debug: ANSI.dim,
};

const LEVEL_COLUMN_WIDTH = 5;

const RESERVED_INFO_KEYS = new Set(["level", "message", "timestamp"]);

export interface ConsoleLogInfo {
	level: string;
	message: unknown;
	timestamp?: string | number;
	[key: string]: unknown;
}

// Evaluated per-record (not at load) so the transport reflects the live env:
// non-TTY (CI, piped, redirected) and production never get an ANSI escape.
export function shouldColorizeConsole(): boolean {
	return isDevelopment() && Boolean(process.stdout.isTTY);
}

function formatClockTimestamp(raw: unknown): string {
	const candidate =
		typeof raw === "string" || typeof raw === "number"
			? new Date(raw)
			: new Date();
	const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	const ms = String(date.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

// Errors serialize to `{}` under JSON.stringify by default — surface the fields.
function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

function extractMetadata(info: ConsoleLogInfo): Record<string, unknown> {
	const meta: Record<string, unknown> = {};
	for (const key of Object.keys(info)) {
		if (!RESERVED_INFO_KEYS.has(key)) {
			meta[key] = info[key];
		}
	}
	return meta;
}

export function formatConsoleEntry(
	info: ConsoleLogInfo,
	useColor: boolean,
): string {
	const timestamp = formatClockTimestamp(info.timestamp);
	const levelLabel = info.level.padEnd(LEVEL_COLUMN_WIDTH);

	const renderedTimestamp = useColor
		? `${ANSI.dim}${timestamp}${ANSI.reset}`
		: timestamp;
	const renderedLevel = useColor
		? `${LEVEL_ANSI[info.level] ?? ""}${levelLabel}${ANSI.reset}`
		: levelLabel;

	const meta = extractMetadata(info);
	let renderedMeta = "";
	if (Object.keys(meta).length > 0) {
		const json = JSON.stringify(meta, jsonReplacer, 2);
		renderedMeta = `\n${json
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n")}`;
	}

	return `${renderedTimestamp} ${renderedLevel} ${String(info.message)}${renderedMeta}`;
}

/**
 * Fixed production log schema. One shape for the file transport AND the prod
 * console so journal/log shippers parse a single record format:
 *   { ts, level, msg, module?, meta? }
 * `ts` is ISO-8601 UTC; `module` is lifted out of the metadata when present;
 * every remaining non-reserved field is folded under `meta`.
 */
export interface ProdLogRecord {
	ts: string;
	level: string;
	msg: string;
	module?: string;
	meta?: Record<string, unknown>;
}

export interface StructuredLogInfo {
	level: string;
	message: unknown;
	timestamp?: string | number;
	module?: unknown;
	[key: string]: unknown;
}

// `module` joins the console reserved set: it is promoted to a top-level schema
// field, so it must not also appear inside `meta`.
const STRUCTURED_RESERVED_KEYS = new Set([
	"level",
	"message",
	"timestamp",
	"module",
]);

// winston's timestamp() default is already ISO-8601, but a caller-supplied
// `timestamp` (string/number) is normalised so `ts` is always a valid ISO
// string; an unparseable value is kept verbatim rather than dropped.
function toIsoTimestamp(raw: unknown): string {
	if (typeof raw === "string") {
		const parsed = new Date(raw);
		return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
	}
	if (typeof raw === "number") {
		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed.toISOString();
		}
	}
	return new Date().toISOString();
}

/**
 * Serialise a redacted info record to a single line of the fixed production
 * schema. Pure (no ANSI, no color) and journal-friendly — used by both the file
 * transport and the production console. Redaction has already run upstream
 * (`structuredBase`), so this only maps fields; `jsonReplacer` surfaces Error
 * objects that JSON.stringify would otherwise flatten to `{}`.
 */
export function formatProdEntry(info: StructuredLogInfo): string {
	const record: ProdLogRecord = {
		ts: toIsoTimestamp(info.timestamp),
		level: info.level,
		msg: String(info.message),
	};

	if (info.module !== undefined && info.module !== null) {
		record.module = String(info.module);
	}

	const meta: Record<string, unknown> = {};
	for (const key of Object.keys(info)) {
		if (!STRUCTURED_RESERVED_KEYS.has(key)) {
			meta[key] = info[key];
		}
	}
	if (Object.keys(meta).length > 0) {
		record.meta = meta;
	}

	return JSON.stringify(record, jsonReplacer);
}

/**
 * Per-transport level with a single optional override. When `LOG_LEVEL` is set
 * (non-empty) it wins for EVERY transport; otherwise each transport keeps its
 * default (dev console `info`, prod console `warn`, file `debug`).
 */
export function resolveLogLevel(defaultLevel: string): string {
	const override = process.env.LOG_LEVEL;
	if (typeof override === "string" && override.trim().length > 0) {
		return override.trim();
	}
	return defaultLevel;
}

/**
 * In-memory log ring buffer (observable-logs substrate).
 *
 * A real device surfaces the backend's journal via `journalctl -u
 * ceralive.service`; a dev/CI host has no systemd journal, so the same backend
 * log records are mirrored into this bounded ring. `modules/system/logs.ts`
 * serves the ring (under `shouldUseMocks()`) so the getLog/getSyslog → `log`
 * push → LogsDialog download path is exercisable end-to-end without hardware.
 * The capture is fed by a Winston `Stream` transport at `debug` level, after
 * `redact()` has already scrubbed secrets, so nothing sensitive is retained.
 */
export const LOG_RING_CAPACITY = 1000;

const logRing: string[] = [];

const logRingStream = new Writable({
	write(chunk: Buffer | string, _encoding, callback) {
		const line = chunk.toString("utf8").replace(/\n+$/, "");
		if (line.length > 0) {
			logRing.push(line);
			if (logRing.length > LOG_RING_CAPACITY) {
				logRing.shift();
			}
		}
		callback();
	},
});

/** Most-recent backend log lines (oldest first), capped at {@link LOG_RING_CAPACITY}. */
export function getRecentLogLines(): string[] {
	return [...logRing];
}

/** Drop every captured line — used by tests for a deterministic baseline. */
export function clearRecentLogLines(): void {
	logRing.length = 0;
}

export const logger = winston.createLogger({
	format: structuredBase,
	defaultMeta: {},
	transports: [
		new winston.transports.Stream({
			stream: logRingStream,
			level: resolveLogLevel("debug"),
			eol: "\n",
			format: winston.format.combine(
				structuredBase,
				winston.format.printf((info) =>
					formatProdEntry(info as StructuredLogInfo),
				),
			),
		}),
		new winston.transports.Console({
			level: resolveLogLevel(isDev ? "info" : "warn"),
			format: winston.format.combine(
				structuredBase,
				winston.format.printf((info) =>
					isDevelopment()
						? formatConsoleEntry(
								info as ConsoleLogInfo,
								shouldColorizeConsole(),
							)
						: formatProdEntry(info as StructuredLogInfo),
				),
			),
		}),
		new winston.transports.File({
			filename: LOG_FILENAME,
			level: resolveLogLevel("debug"),
			maxsize: LOG_MAX_SIZE_BYTES,
			maxFiles: LOG_MAX_FILES,
			tailable: true,
			format: winston.format.combine(
				structuredBase,
				winston.format.printf((info) =>
					formatProdEntry(info as StructuredLogInfo),
				),
			),
		}),
	],
});
