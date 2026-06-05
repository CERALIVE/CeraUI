import winston from "winston";

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

export const logger = winston.createLogger({
	// Structured JSON on disk: timestamped, machine-parseable records.
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json(),
	),
	defaultMeta: {},
	transports: [
		// Console stays human-readable; no rotation needed (not persisted).
		new winston.transports.Console({
			level: isDev ? "info" : "warn",
			format: winston.format.simple(),
		}),
		// Persisted file: structured JSON, size-bounded with rotation.
		new winston.transports.File({
			filename: LOG_FILENAME,
			level: "debug",
			maxsize: LOG_MAX_SIZE_BYTES,
			maxFiles: LOG_MAX_FILES,
			tailable: true,
		}),
	],
});
