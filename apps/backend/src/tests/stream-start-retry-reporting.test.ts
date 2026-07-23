import { describe, expect, test } from "bun:test";

import { deriveStartSuppressionContext } from "../modules/streaming/stream-start-retry-reporting.ts";

describe("stream start suppression signal derivation", () => {
	test("a healthy live capability snapshot is not a restart window", () => {
		expect(
			deriveStartSuppressionContext({
				softwareUpdateActive: false,
				capabilities: {
					engineUnavailable: false,
				},
				uptimeMs: 120_000,
			}),
		).toEqual({
			softwareUpdateActive: false,
			engineRestartWindow: false,
			bootWindow: false,
			cancelledByStop: false,
		});
	});

	test("a cached unavailable snapshot is a known restart window", () => {
		expect(
			deriveStartSuppressionContext({
				softwareUpdateActive: false,
				capabilities: {
					engineUnavailable: true,
				},
				uptimeMs: 120_000,
			}),
		).toMatchObject({
			engineRestartWindow: true,
			bootWindow: false,
		});
	});

	test("an engine-starting snapshot keeps the boot window calm", () => {
		expect(
			deriveStartSuppressionContext({
				softwareUpdateActive: false,
				capabilities: {
					engineUnavailable: true,
					engineStarting: true,
				},
				uptimeMs: 120_000,
			}),
		).toMatchObject({
			engineRestartWindow: false,
			bootWindow: true,
		});
	});
});
