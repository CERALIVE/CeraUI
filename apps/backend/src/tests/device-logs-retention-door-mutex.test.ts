import { afterEach, expect, spyOn, test } from "bun:test";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import * as retention from "../modules/device-logs/retention.ts";
import * as files from "../modules/device-logs/retention-files.ts";
import * as settings from "../modules/device-logs/settings.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});
const actions = {
	daily: () => retention.maintain(),
	settings: () =>
		retention.setRetention({ maxAgeDays: 7, maxSizeMb: 64, detail: "info" }),
	legacy: () => retention.deleteLegacyDebug(),
};
for (const mock of [false, true]) {
	for (const [name, mutate] of Object.entries(actions)) {
		test(`${name} before and after ${mock ? "mock" : "native"} clear serializes with the required history gate`, async () => {
			h = historyFixture(mock);
			settings.saveLogSettings({
				maxAgeDays: 7,
				maxSizeMb: 64,
				detail: "info",
			});
			const beforeReadout = h.ownedLatch();
			const clearReadout = h.ownedLatch();
			const baseline = h.scan.getMockImplementation();
			if (!baseline) throw new Error("missing reader transport");
			h.scan.mockImplementationOnce(async (input) => {
				const result = await baseline(input);
				await beforeReadout.hold();
				return result;
			});
			const bytes = files.legacyDebugBytes;
			const storage = spyOn(files, "legacyDebugBytes").mockImplementation(
				async () => {
					if (settings.getLogState().lastClearedAt !== null)
						await clearReadout.hold();
					return bytes();
				},
			);
			const trace: string[] = [];
			const before = h.own(
				mutate().then((result) => {
					trace.push("before");
					return result;
				}),
			);
			await bounded(beforeReadout.entered);
			const clearing = h.own(
				retention.clearAll().then((result) => {
					trace.push("clear");
					return result;
				}),
			);
			const after = h.own(
				mutate().then((result) => {
					trace.push("after");
					return result;
				}),
			);
			try {
				// A clear queued behind a non-destructive mutation leaves the door open.
				const ticket = await bounded(createExport({}, { filter: {} }));
				if (!ticket.ok) throw new Error(ticket.error);
				const old = await handleLogExportRequest(
					new Request(`http://device${ticket.url}`),
				);
				expect(await bounded(old.text())).toContain("before-clear");
				expect(settings.getLogState().historyEpoch).toBe(0);
				expect(trace).toEqual([]);
				beforeReadout.release();
				await bounded(clearReadout.entered);
				expect(trace).toEqual(["before"]);
				let admitted = false;
				const incoming = h.own(
					createExport({}, { filter: {} }).then((result) => {
						admitted = true;
						return result;
					}),
				);
				await turn();
				expect(admitted).toBe(false);
				clearReadout.release();
				await bounded(Promise.all([clearing, after]));
				expect(trace).toEqual(["before", "clear", "after"]);
				expect((await bounded(incoming)).ok).toBe(true);
				expect(settings.getLogState().historyEpoch).toBe(1);
			} finally {
				beforeReadout.release();
				clearReadout.release();
				await bounded(Promise.allSettled([before, clearing, after]));
				storage.mockRestore();
			}
		});
	}
}
