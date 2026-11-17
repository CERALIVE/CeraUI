import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { bootId, journal, queryFixture } from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	collect = spyOn(data, "collectBundleData").mockResolvedValue({
		exportedBy: {
			bootId,
			ceraui: "ui",
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		},
		boots: [{ bootId, versions: null }],
		journalBoots: [bootId],
		settings: {
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable",
			autostart: null,
			hardwareKind: "generic",
			data: null,
		},
		events: [],
		bootRecords: [],
		secrets: [],
	});
});
afterEach(async () => {
	await abortLogBundles();
	collect.mockRestore();
	fixture.restore();
});

test.each(["enqueue", "abort", "close", "clear"] as const)(
	"a download read settles after %s without waiting for the transport deadline",
	async (mode) => {
		const created = await createBundle({});
		if (!created.ok) throw new Error(created.error);
		const controller = new AbortController();
		const response = await handleLogBundleRequest(
			new Request(`http://device${created.url}`, { signal: controller.signal }),
		);
		if (!response.body) throw new Error("missing bundle body");
		const reader = response.body.getReader();
		const overrides: Array<{ mockRestore(): void }> = [];
		switch (mode) {
			case "enqueue":
				overrides.push(
					spyOn(
						ReadableStreamDefaultController.prototype,
						"enqueue",
					).mockImplementation(() => {
						throw new Error("PLANTED-SECRET");
					}),
				);
				break;
			case "close":
				overrides.push(
					spyOn(
						ReadableStreamDefaultController.prototype,
						"close",
					).mockImplementation(() => {
						throw new Error("PLANTED-SECRET");
					}),
				);
				break;
			case "abort":
			case "clear":
				break;
			default: {
				const impossible: never = mode;
				throw new Error(String(impossible));
			}
		}
		let outcome = "pending";
		let readFailed = false;
		let reading: Promise<void> | undefined;
		try {
			switch (mode) {
				case "enqueue":
					break;
				case "abort":
				case "close":
					controller.abort();
					break;
				case "clear":
					await abortLogBundles();
					break;
				default: {
					const impossible: never = mode;
					throw new Error(String(impossible));
				}
			}
			reading = reader.read().then(
				(value) => {
					outcome = value.done ? "closed" : "chunk";
				},
				(error: unknown) => {
					readFailed = true;
					outcome = error instanceof Error ? error.message : String(error);
				},
			);
			// A task boundary drains the triggered read/abort microtasks without a sleep.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcome).toBe(
				mode === "enqueue" || mode === "close" ? "READ_FAILED" : "closed",
			);
		} finally {
			for (const override of overrides) override.mockRestore();
			if (!readFailed) await reader.cancel();
			await reading;
		}
	},
);

test.each([
	{ download: false, timerCount: 1 },
	{ download: true, timerCount: 2 },
])(
	"completed sharing clears every timer it owns: %j",
	async ({ download, timerCount }) => {
		const scheduled = spyOn(globalThis, "setTimeout");
		const cleared = spyOn(globalThis, "clearTimeout");
		try {
			if (download) {
				const created = await createBundle({});
				if (!created.ok) throw new Error(created.error);
				const response = await handleLogBundleRequest(
					new Request(`http://device${created.url}`),
				);
				await response.arrayBuffer();
			} else await previewBundle();
			expect(scheduled).toHaveBeenCalledTimes(timerCount);
			for (const timer of scheduled.mock.results) {
				if (timer.type !== "return") throw new Error("timer did not return");
				expect(cleared).toHaveBeenCalledWith(timer.value);
				expect(
					cleared.mock.calls.some(([handle]) => handle === timer.value),
				).toBe(true);
			}
		} finally {
			scheduled.mockRestore();
			cleared.mockRestore();
		}
	},
);
