import { afterEach, describe, expect, test } from "bun:test";

import type { StreamHealthOutput } from "@ceraui/rpc/schemas";

import {
	LOG_FILENAME,
	LOG_MAX_FILES,
	LOG_MAX_SIZE_BYTES,
	LOG_MAX_TOTAL_BYTES,
	logger,
} from "../helpers/logger.ts";
import {
	type LivenessSources,
	setLivenessSourcesForTest,
} from "../modules/streaming/health.ts";
import {
	buildLocalObservabilitySurface,
	getLocalObservability,
} from "../modules/system/observability.ts";

const HEALTHY_ROLLUP: StreamHealthOutput = {
	state: "healthy",
	process: { alive: true },
	frames: { advancing: true, count: 456 },
	srt: { reconnecting: false, reconnectCount: 0 },
	bond: { linkCount: 2, activeLinks: 2 },
};

const DEGRADED_ROLLUP: StreamHealthOutput = {
	state: "degraded",
	process: { alive: true },
	frames: { advancing: false, count: 999 },
	srt: { reconnecting: true, reconnectCount: 7 },
	bond: { linkCount: 3, activeLinks: 1 },
};

const LIVE_SOURCES: LivenessSources = {
	isStreaming: true,
	processAlive: true,
	framesAdvancing: true,
	frameCount: 1234,
	reconnecting: false,
	reconnectCount: 0,
	linkCount: 2,
	activeLinks: 2,
};

afterEach(() => {
	setLivenessSourcesForTest(null);
});

describe("buildLocalObservabilitySurface — pure projection", () => {
	test("projects a health rollup onto the local surface shape", () => {
		const fixedNow = new Date("2026-06-05T12:34:56.000Z");
		const surface = buildLocalObservabilitySurface(
			HEALTHY_ROLLUP,
			123,
			fixedNow,
		);

		expect(surface).toEqual({
			state: "healthy",
			process: { alive: true, uptime: 123 },
			frames: { advancing: true, count: 456 },
			srt: { reconnecting: false, reconnectCount: 0 },
			bond: { linkCount: 2, activeLinks: 2 },
			timestamp: "2026-06-05T12:34:56.000Z",
		});
	});

	test("carries degraded SRT/bond detail through unchanged", () => {
		const surface = buildLocalObservabilitySurface(DEGRADED_ROLLUP, 5);
		expect(surface.frames.advancing).toBe(false);
		expect(surface.srt).toEqual({ reconnecting: true, reconnectCount: 7 });
		expect(surface.bond).toEqual({ linkCount: 3, activeLinks: 1 });
	});

	test("emits an ISO-8601 timestamp", () => {
		const surface = buildLocalObservabilitySurface(HEALTHY_ROLLUP, 1);
		expect(surface.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
	});
});

describe("getLocalObservability — reuses the Task 13 health source", () => {
	test("derives the surface from injected liveness sources", () => {
		setLivenessSourcesForTest(() => LIVE_SOURCES);
		const surface = getLocalObservability();

		expect(surface.process.alive).toBe(true);
		expect(surface.frames).toEqual({ advancing: true, count: 1234 });
		expect(surface.bond).toEqual({ linkCount: 2, activeLinks: 2 });
		expect(surface.srt).toEqual({ reconnecting: false, reconnectCount: 0 });
	});

	test("reports a non-negative numeric process uptime", () => {
		setLivenessSourcesForTest(() => LIVE_SOURCES);
		const surface = getLocalObservability();
		expect(typeof surface.process.uptime).toBe("number");
		expect(surface.process.uptime).toBeGreaterThanOrEqual(0);
	});

	test("idle device: /api/health reads state:idle + alive:null, not a 'dead' alive:false", () => {
		setLivenessSourcesForTest(() => ({
			isStreaming: false,
			processAlive: null,
			framesAdvancing: null,
			frameCount: null,
			reconnecting: null,
			reconnectCount: 0,
			linkCount: 0,
			activeLinks: 0,
		}));
		const surface = getLocalObservability();
		expect(surface.state).toBe("idle");
		expect(surface.process.alive).toBeNull();
		expect(surface.frames.advancing).toBeNull();
		expect(surface.srt.reconnecting).toBeNull();
	});
});

describe("log rotation — bounded on-disk retention", () => {
	test("caps each file at 10 MB", () => {
		expect(LOG_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
	});

	test("keeps at most 5 rotated segments", () => {
		expect(LOG_MAX_FILES).toBe(5);
	});

	test("bounds total log disk use to 50 MB", () => {
		expect(LOG_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024);
		expect(LOG_MAX_TOTAL_BYTES).toBe(LOG_MAX_SIZE_BYTES * LOG_MAX_FILES);
	});

	test("configures the file transport with size + count rotation", () => {
		const fileTransport = logger.transports.find(
			(t) => "filename" in t && t.filename === LOG_FILENAME,
		) as
			| { maxsize?: number; maxFiles?: number; tailable?: boolean }
			| undefined;

		expect(fileTransport).toBeDefined();
		expect(fileTransport?.maxsize).toBe(LOG_MAX_SIZE_BYTES);
		expect(fileTransport?.maxFiles).toBe(LOG_MAX_FILES);
		expect(fileTransport?.tailable).toBe(true);
	});
});
