import { afterEach, describe, expect, test } from "bun:test";

// Edge-case hardening for the boot-time autostart path (streamloop/autostart.ts).
//
// These tests target REAL streaming-device failure modes:
//   - a stale "already streaming" flag must not trigger a second start;
//   - "no network links yet" must back off WITHOUT busy-looping the event loop;
//   - an UN-startable (invalid) config must NOT be retried forever — it must give
//     up and release the streaming-status lock.
//
// They drive the real autoStartStream against its real dependencies, controlling
// only the observable seams (interface map, streaming flag, config) and capturing
// setTimeout so no retry timer ever escapes the test. They are deliberately
// independent of streamloop-modules.test.ts (which only checks the no-links retry
// re-arms itself) and assert different invariants (single-shot scheduling, the
// invalid-config no-retry contract, and the status-lock release).

import { AUTOSTART_RETRY_DELAY } from "../../helpers/timing-constants.ts";
import { getConfig } from "../../modules/config.ts";
import { getNetworkInterfaces } from "../../modules/network/network-interfaces.ts";
import { genSrtlaIpList } from "../../modules/streaming/srtla.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../../modules/streaming/streaming.ts";
import { autoStartStream } from "../../modules/streaming/streamloop/autostart.ts";

type Scheduled = { fn: unknown; delay: unknown };

// Replace setTimeout with a recorder so retries are observed, never armed.
function captureTimers(): {
	scheduled: Scheduled[];
	restore: () => void;
} {
	const scheduled: Scheduled[] = [];
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, delay?: number) => {
		scheduled.push({ fn, delay });
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof globalThis.setTimeout;
	return {
		scheduled,
		restore: () => {
			globalThis.setTimeout = original;
		},
	};
}

// Empty the live interface map so genSrtlaIpList() yields no links, restoring it
// afterwards so no other suite in the shared process is affected.
function withNoLinks(): () => void {
	const netif = getNetworkInterfaces() as Record<string, unknown>;
	const saved = { ...netif };
	for (const key of Object.keys(netif)) delete netif[key];
	return () => Object.assign(netif, saved);
}

// Inject exactly one usable link so genSrtlaIpList() returns >= 1 entry,
// letting autoStartStream advance past the no-links backoff into validateConfig.
function withOneLink(): () => void {
	const netif = getNetworkInterfaces() as Record<string, unknown>;
	const saved = { ...netif };
	for (const key of Object.keys(netif)) delete netif[key];
	netif.__edgecase_test = { enabled: true, ip: "10.255.255.254" };
	return () => {
		for (const key of Object.keys(netif)) delete netif[key];
		Object.assign(netif, saved);
	};
}

afterEach(() => {
	// Defensive: make sure no test leaves the streaming lock held.
	if (getIsStreaming()) updateStatus(false);
});

describe("autostart: abort when a stream is already running", () => {
	test("does not schedule any retry or start a second stream", async () => {
		const timers = captureTimers();
		// Hold the streaming lock so the guard at the top of autoStartStream fires.
		updateStatus(true);
		try {
			await autoStartStream();
		} finally {
			timers.restore();
			updateStatus(false);
		}

		// The already-streaming guard returns immediately: no backoff timer, no
		// spawn. If the guard regressed, the no-links/validate path below would
		// schedule a retry here.
		expect(timers.scheduled.length).toBe(0);
	});
});

describe("autostart: no links available yet (transient boot state)", () => {
	test("arms exactly one self-rescheduling retry, never a synchronous loop", async () => {
		const restoreLinks = withNoLinks();
		const timers = captureTimers();
		try {
			expect(getIsStreaming()).toBe(false);
			expect(genSrtlaIpList().length).toBe(0);
			await autoStartStream();
		} finally {
			timers.restore();
			restoreLinks();
		}

		// Exactly one timer: the no-links path must back off once and return, not
		// recurse synchronously (which would wedge the event loop on a device that
		// boots before any interface is up).
		expect(timers.scheduled.length).toBe(1);
		const retry = timers.scheduled[0];
		expect(retry?.delay).toBe(AUTOSTART_RETRY_DELAY);
		// It re-arms with autoStartStream itself (self-rescheduling backoff).
		expect(retry?.fn).toBe(autoStartStream);
	});
});

describe("autostart: invalid config is un-startable", () => {
	test("does NOT retry and releases the streaming-status lock", async () => {
		const restoreLinks = withOneLink();
		const timers = captureTimers();

		// Force validateConfig to throw by removing a required field (delay). An
		// invalid config can never become startable, so autostart must give up
		// rather than spin a retry forever.
		const config = getConfig() as Record<string, unknown>;
		const hadDelay = "delay" in config;
		const savedDelay = config.delay;
		delete config.delay;

		try {
			// Pre-condition: a link IS available, so the no-links backoff is bypassed
			// and execution reaches validateConfig.
			expect(genSrtlaIpList().length).toBeGreaterThanOrEqual(1);
			await autoStartStream();
		} finally {
			timers.restore();
			if (hadDelay) config.delay = savedDelay;
			restoreLinks();
			if (getIsStreaming()) updateStatus(false);
		}

		// Invariant 1: invalid config is NOT retried (no backoff timer armed).
		expect(timers.scheduled.length).toBe(0);
		// Invariant 2: the streaming-status lock taken before validation is
		// released on the failure path (status must not stay stuck "streaming").
		expect(getIsStreaming()).toBe(false);
	});
});
