import { describe, expect, test } from "bun:test";

// streamloop.ts was split into focused modules under ./streamloop/. These tests
// lock the MODULE BOUNDARIES the split introduced: the public re-export barrel
// must reproduce the original API exactly, each symbol must still be owned by its
// new sub-module, and the extracted seams (exec paths, process supervision,
// autostart backoff) must behave as before. They are deliberately independent of
// streamloop.test.ts (which covers the raw Bun.spawn stream semantics) and must
// not require it to change.

import { AUTOSTART_RETRY_DELAY } from "../helpers/timing-constants.ts";
import { getNetworkInterfaces } from "../modules/network/network-interfaces.ts";
import { genSrtlaIpList } from "../modules/streaming/srtla.ts";
import { getIsStreaming } from "../modules/streaming/streaming.ts";
import {
	AUTOSTART_CHECK_FILE as autostartCheckFile,
	autoStartStream as autostartFn,
	checkAutoStartStream as checkAutostartFn,
	setAutostart as setAutostartFn,
} from "../modules/streaming/streamloop/autostart.ts";
import {
	bcrptExec as bcrptExecOwned,
	ceracoderExec as ceracoderExecOwned,
	srtlaSendExec as srtlaSendExecOwned,
} from "../modules/streaming/streamloop/exec-paths.ts";
import { getStreamingProcesses } from "../modules/streaming/streamloop/process-runner.ts";
import {
	start as startOwned,
	stop as stopOwned,
} from "../modules/streaming/streamloop/session.ts";
import { startStream as startStreamOwned } from "../modules/streaming/streamloop/start-stream.ts";
import * as barrel from "../modules/streaming/streamloop.ts";

// The exact symbols the pre-split streamloop.ts exported, with their kinds.
const LOCKED_API: Record<string, "string" | "function"> = {
	AUTOSTART_CHECK_FILE: "string",
	autoStartStream: "function",
	bcrptExec: "string",
	ceracoderExec: "string",
	checkAutoStartStream: "function",
	setAutostart: "function",
	srtlaSendExec: "string",
	start: "function",
	startStream: "function",
	stop: "function",
};

describe("streamloop public API surface is preserved by the split", () => {
	test("barrel re-exports exactly the locked symbols, nothing dropped or added", () => {
		const exported = Object.keys(barrel).sort();
		expect(exported).toEqual(Object.keys(LOCKED_API).sort());
	});

	test("every locked symbol keeps its original kind (string const vs function)", () => {
		for (const [name, kind] of Object.entries(LOCKED_API)) {
			expect(typeof (barrel as Record<string, unknown>)[name]).toBe(kind);
		}
	});
});

describe("barrel routes each symbol to its new owning sub-module", () => {
	test("exec-path constants are owned by exec-paths.ts", () => {
		expect(barrel.ceracoderExec).toBe(ceracoderExecOwned);
		expect(barrel.srtlaSendExec).toBe(srtlaSendExecOwned);
		expect(barrel.bcrptExec).toBe(bcrptExecOwned);
	});

	test("session control is owned by session.ts", () => {
		expect(barrel.start).toBe(startOwned);
		expect(barrel.stop).toBe(stopOwned);
	});

	test("startStream is owned by start-stream.ts", () => {
		expect(barrel.startStream).toBe(startStreamOwned);
	});

	test("autostart lifecycle is owned by autostart.ts", () => {
		expect(barrel.AUTOSTART_CHECK_FILE).toBe(autostartCheckFile);
		expect(barrel.autoStartStream).toBe(autostartFn);
		expect(barrel.checkAutoStartStream).toBe(checkAutostartFn);
		expect(barrel.setAutostart).toBe(setAutostartFn);
	});
});

describe("exec-paths.ts extraction", () => {
	test("derives the bcrpt executable path and exposes string exec paths", () => {
		expect(typeof bcrptExecOwned).toBe("string");
		expect(bcrptExecOwned.endsWith("/bcrpt")).toBe(true);
		expect(typeof ceracoderExecOwned).toBe("string");
		expect(typeof srtlaSendExecOwned).toBe("string");
	});
});

describe("process-runner.ts supervision seam", () => {
	test("getStreamingProcesses returns an (initially empty) live list", () => {
		const procs = getStreamingProcesses();
		expect(Array.isArray(procs)).toBe(true);
		// No stream has been started in this suite, so nothing is supervised yet.
		expect(procs.length).toBe(0);
	});
});

describe("autostart.ts backoff seam", () => {
	test("autoStartStream re-arms a retry timer when no srtla links are available", async () => {
		// Force the backoff precondition (no available srtla links) deterministically,
		// independent of any network-interface state earlier test files left in this
		// shared process: empty the live interface map so genSrtlaIpList() yields no
		// links, then restore it in `finally` so no other suite is affected.
		const netif = getNetworkInterfaces() as Record<string, unknown>;
		const savedNetif = { ...netif };
		for (const key of Object.keys(netif)) {
			delete netif[key];
		}

		// Capture timer scheduling without actually arming a real timer, so the
		// retry doesn't leak past the test. autoStartStream's no-links path runs
		// synchronously up to this setTimeout call, then returns.
		const originalSetTimeout = globalThis.setTimeout;
		const scheduled: Array<{ fn: unknown; delay: unknown }> = [];
		globalThis.setTimeout = ((fn: () => void, delay?: number) => {
			scheduled.push({ fn, delay });
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;

		try {
			expect(getIsStreaming()).toBe(false);
			expect(genSrtlaIpList().length).toBe(0);
			await autostartFn();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			Object.assign(netif, savedNetif);
		}

		const retry = scheduled.find((s) => s.delay === AUTOSTART_RETRY_DELAY);
		expect(retry).toBeDefined();
		expect(typeof retry?.fn).toBe("function");
		// It must retry with autoStartStream itself (self-rescheduling backoff).
		expect(retry?.fn).toBe(autostartFn);
	});
});
