import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runModule from "../helpers/run.ts";
import * as mockService from "../mocks/mock-service.ts";
import { getLog } from "../modules/system/logs.ts";
import * as notifications from "../modules/ui/notifications.ts";

const MAX_BUFFER = 10 * 1024 * 1024;

type RunCall = [string, string[], { maxBuffer: number }];

function fakeConn(sent: string[]) {
	return {
		send: (frame: string) => sent.push(frame),
		data: { senderId: "characterization" },
	} as never;
}

function journalctlCalls(spy: { mock: { calls: unknown[][] } }): RunCall[] {
	return spy.mock.calls.filter(
		(call): call is RunCall => call[0] === "journalctl",
	);
}

function expectLogPush(sent: string[], name: string, contents: string): void {
	expect(sent).toHaveLength(1);
	expect(JSON.parse(sent[0] ?? "")).toEqual({
		log: { name, contents },
		id: "characterization",
	});
}

afterEach(() => {
	spyOn(runModule, "run").mockRestore?.();
	spyOn(mockService, "shouldUseMocks").mockRestore?.();
	spyOn(notifications, "notificationSend").mockRestore?.();
	spyOn(logger, "error").mockRestore?.();
});

describe("legacy system log download path", () => {
	it("gets a service journal, returns its file and sends one matching frame", async () => {
		const contents = "service journal output";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(contents);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const sent: string[] = [];

		const result = await getLog(fakeConn(sent), "ceralive.service");

		expect(journalctlCalls(runSpy)).toEqual([
			[
				"journalctl",
				["-b", "-u", "ceralive.service"],
				{ maxBuffer: MAX_BUFFER },
			],
		]);
		expect(result).toEqual({
			name: "ceralive.service_log.txt",
			contents,
		});
		expectLogPush(sent, "ceralive.service_log.txt", contents);
	});

	it("gets the full boot journal when no service is supplied", async () => {
		const contents = "full journal output";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(contents);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const sent: string[] = [];

		const result = await getLog(fakeConn(sent));

		expect(journalctlCalls(runSpy)).toEqual([
			["journalctl", ["-b"], { maxBuffer: MAX_BUFFER }],
		]);
		expect(result).toEqual({
			name: "ceralive_system_log.txt",
			contents,
		});
		expectLogPush(sent, "ceralive_system_log.txt", contents);
	});

	it("returns undefined and raises log_error without a log frame on failure", async () => {
		const runSpy = spyOn(runModule, "run").mockRejectedValue(
			new Error("journalctl unavailable"),
		);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const notify = spyOn(notifications, "notificationSend");
		spyOn(logger, "error").mockImplementation(() => logger);
		const sent: string[] = [];
		const conn = fakeConn(sent);

		const result = await getLog(conn, "ceralive.service");

		expect(journalctlCalls(runSpy)).toEqual([
			[
				"journalctl",
				["-b", "-u", "ceralive.service"],
				{ maxBuffer: MAX_BUFFER },
			],
		]);
		expect(result).toBeUndefined();
		expect(sent).toHaveLength(1);
		const frame = JSON.parse(sent[0] ?? "") as Record<string, unknown>;
		expect("log" in frame).toBe(false);
		expect(frame).toEqual({
			notification: {
				show: [
					{
						name: "log_error",
						type: "error",
						msg: "Failed to fetch the log: Error: journalctl unavailable",
						is_dismissable: true,
						is_persistent: false,
						duration: 10,
					},
				],
			},
			id: "characterization",
		});
		expect(notify).toHaveBeenCalledWith(
			conn,
			"log_error",
			"error",
			"Failed to fetch the log: Error: journalctl unavailable",
			10,
		);
	});

	it("uses the mock journal header for unit and full-journal downloads", async () => {
		const runSpy = spyOn(runModule, "run");
		spyOn(mockService, "shouldUseMocks").mockReturnValue(true);

		const unit = await getLog(fakeConn([]), "ceralive.service");
		const system = await getLog(fakeConn([]));

		expect(
			unit?.contents.startsWith(
				"-- Logs begin for unit ceralive.service (CeraUI mock journal) --",
			),
		).toBe(true);
		expect(
			system?.contents.startsWith(
				"-- Logs begin, full CeraUI system journal (mock) --",
			),
		).toBe(true);
		expect(journalctlCalls(runSpy)).toEqual([]);
	});
});
