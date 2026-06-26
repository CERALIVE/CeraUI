/*
 * Task 13 — observable logs + persistent notifications (S8).
 *
 * Proves the getLog/getSyslog RPC is a REAL data source (not the former
 * `{ log: "" }` stub) and that a known backend log event is retrievable through
 * the chosen path:
 *
 *  - getLog/getSyslog handlers invoke modules/system/logs.ts, return the real
 *    journal contents, AND push the `log` event the LogsDialog turns into a
 *    download (both halves of the contract).
 *  - getLog defaults to the `ceralive.service` unit (the device/application log);
 *    getSyslog is the unfiltered boot journal.
 *  - the in-memory log ring buffer captures a real backend logger event, so the
 *    dev/CI mock journal that getLog serves contains it.
 *  - notifications.getPersistent returns the live persistent set (not an empty
 *    stub) so the pull endpoint mirrors the `notification` push the panel reads.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { call } from "@orpc/server";

import {
	clearRecentLogLines,
	getRecentLogLines,
	logger,
} from "../helpers/logger.ts";
import * as runModule from "../helpers/run.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { getPersistentNotificationsProcedure } from "../rpc/procedures/notifications.procedure.ts";
import {
	getLogProcedure,
	getSyslogProcedure,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const MAX_BUFFER = 10 * 1024 * 1024;

/** Capturing RPC context: records every frame the handler pushes to the socket. */
function makeContext(sent: string[]): RPCContext {
	const ws = {
		send: (frame: string) => {
			sent.push(frame);
		},
		data: { isAuthenticated: true, lastActive: Date.now(), senderId: "test" },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

/** Find the pushed `{ log: { name, contents } }` frame. */
function findLogPush(
	sent: string[],
): { name: string; contents: string } | undefined {
	for (const frame of sent) {
		const parsed = JSON.parse(frame) as {
			log?: { name: string; contents: string };
		};
		if (parsed.log) return parsed.log;
	}
	return undefined;
}

afterEach(() => {
	spyOn(runModule, "run").mockRestore?.();
});

describe("system.getLog / system.getSyslog — real data + log push", () => {
	it("getLog returns the journal contents (NOT an empty stub) and pushes a log frame", async () => {
		const KNOWN = "Jun 25 12:00:00 ceralive[42]: known boot event marker";
		spyOn(runModule, "run").mockResolvedValue(KNOWN);

		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});

		expect(result.log).toBe(KNOWN);
		expect(result.log).not.toBe("");

		const push = findLogPush(sent);
		expect(push).toBeDefined();
		expect(push?.contents).toBe(KNOWN);
		expect(push?.name).toBe("ceralive.service_log.txt");
	});

	it("getLog defaults to the ceralive.service unit; an explicit service overrides", async () => {
		const runSpy = spyOn(runModule, "run").mockResolvedValue("x");

		await call(getLogProcedure, undefined, { context: makeContext([]) });
		expect(runSpy).toHaveBeenLastCalledWith(
			"journalctl",
			["-b", "-u", "ceralive.service"],
			{ maxBuffer: MAX_BUFFER },
		);

		await call(
			getLogProcedure,
			{ service: "ssh.service" },
			{
				context: makeContext([]),
			},
		);
		expect(runSpy).toHaveBeenLastCalledWith(
			"journalctl",
			["-b", "-u", "ssh.service"],
			{ maxBuffer: MAX_BUFFER },
		);
	});

	it("getSyslog returns the full boot journal (no unit filter) and pushes it", async () => {
		const KNOWN = "Jun 25 12:00:01 kernel: full system journal line";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(KNOWN);

		const sent: string[] = [];
		const result = await call(getSyslogProcedure, undefined, {
			context: makeContext(sent),
		});

		expect(runSpy).toHaveBeenLastCalledWith("journalctl", ["-b"], {
			maxBuffer: MAX_BUFFER,
		});
		expect(result.log).toBe(KNOWN);
		expect(findLogPush(sent)?.contents).toBe(KNOWN);
	});

	it("getLog degrades to an empty string (never throws) when journalctl fails", async () => {
		spyOn(runModule, "run").mockRejectedValue(new Error("journalctl boom"));

		const result = await call(getLogProcedure, undefined, {
			context: makeContext([]),
		});
		expect(result.log).toBe("");
	});
});

describe("log ring buffer — observable-logs substrate", () => {
	it("captures a real backend logger event for the dev/CI mock journal", async () => {
		clearRecentLogLines();
		logger.error("RING-MARKER known backend failure xyz", { module: "test" });
		// Winston flushes the Stream transport on the next tick.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const captured = getRecentLogLines().join("\n");
		expect(captured).toContain("RING-MARKER known backend failure xyz");
	});
});

describe("notifications.getPersistent — real persistent set", () => {
	const NAME = "task13-observable-logs-marker";

	beforeEach(() => {
		notificationRemove(NAME);
	});
	afterEach(() => {
		notificationRemove(NAME);
	});

	it("returns the live persistent notifications (NOT an empty stub)", async () => {
		notificationBroadcast(NAME, "error", "Known backend failure", 0, true);

		const result = await call(getPersistentNotificationsProcedure, undefined, {
			context: makeContext([]),
		});

		const item = result.show.find((n) => n.name === NAME);
		expect(item).toBeDefined();
		expect(item?.msg).toBe("Known backend failure");
		expect(item?.is_persistent).toBe(true);
	});
});
