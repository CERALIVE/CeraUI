import { describe, expect, test } from "bun:test";
import { logger } from "../helpers/logger.ts";

describe("streaming modules logger integration", () => {
	test("bcrpt: logger.error accepts max retries exhaustion message", () => {
		// Verify logger.error method exists and accepts the expected message format
		const MAX_BCRPT_RETRIES = 5;
		const bcrptRetryCount = MAX_BCRPT_RETRIES;

		expect(() => {
			if (bcrptRetryCount >= MAX_BCRPT_RETRIES) {
				logger.error(
					`BCRPT process failed ${MAX_BCRPT_RETRIES} times. Stopping restart attempts.`,
				);
			}
		}).not.toThrow();
	});

	test("bcrpt: logger.warn accepts config generation retry message", () => {
		// Verify logger.warn method exists and accepts the expected message format
		const MAX_BCRPT_RETRIES = 5;
		const bcrptRetryCount = 1;
		const INITIAL_RETRY_DELAY = 1000;

		expect(() => {
			const delay = INITIAL_RETRY_DELAY * 2 ** (bcrptRetryCount - 1);
			logger.warn(
				`BCRPT config generation failed (attempt ${bcrptRetryCount}/${MAX_BCRPT_RETRIES}). Retrying in ${delay}ms...`,
			);
		}).not.toThrow();
	});

	test("streamloop: logger.error accepts config save failure with structured metadata", () => {
		// Verify logger.error method exists and accepts structured metadata
		const err = new Error("Config save failed");
		expect(() => {
			logger.error("Failed to save config", { err });
		}).not.toThrow();
	});

	test("streamloop: logger.error accepts stream start failure with structured metadata", () => {
		// Verify logger.error method exists and accepts structured metadata
		const err = new Error("Stream start failed");
		expect(() => {
			logger.error("Failed to start stream", { err });
		}).not.toThrow();
	});

	test("streamloop: logger.error accepts autostart validation failure with structured metadata", () => {
		// Verify logger.error method exists and accepts structured metadata
		const err = new Error("Config validation failed");
		expect(() => {
			logger.error("autostart failed", { err });
		}).not.toThrow();
	});

	test("streamloop: logger.warn accepts autostart retry with structured metadata", () => {
		// Verify logger.warn method exists and accepts structured metadata
		const err = new Error("Temporary failure");
		expect(() => {
			logger.warn("autostart failed, but will retry", { err });
		}).not.toThrow();
	});

	test("encoder: logger.error accepts bitrate set failure with structured metadata", () => {
		// Verify logger.error method exists and accepts structured metadata
		const error = new Error("Failed to write ceracoder config");
		expect(() => {
			logger.error("Failed to set bitrate", { error });
		}).not.toThrow();
	});

	test("bcrpt: logger.info accepts startup mode selection message", () => {
		// Verify logger.info method exists and accepts the expected message format
		const isMockBcrpt = true;
		expect(() => {
			if (isMockBcrpt) {
				logger.info("Starting BCRPT in development mode (using mock)");
			}
		}).not.toThrow();
	});

	test("bcrpt: logger.debug accepts stdout parse error with structured metadata", () => {
		// Verify logger.debug method exists and accepts structured metadata
		const err = new Error("JSON parse failed");
		const data = "invalid json";
		expect(() => {
			logger.debug("BCRPT stdout parse error", { err, data });
		}).not.toThrow();
	});

	test("streamloop: logger.info accepts autostart completion message", () => {
		// Verify logger.info method exists and accepts the expected message format
		expect(() => {
			logger.info("autostart complete");
		}).not.toThrow();
	});

	test("logger has all required methods for streaming modules", () => {
		// Verify logger object has all required methods
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.debug).toBe("function");
	});
});
