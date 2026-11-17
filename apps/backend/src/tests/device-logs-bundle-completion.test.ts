import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
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
	await abortLogExports();
	collect.mockRestore();
	fixture.restore();
});

test("clear settles after the aborted preparation has completed", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async ({ signal }) => {
		if (!signal) throw new Error("missing scan signal");
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		entered.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const building = createBundle({});
	await entered.promise;
	let settled = false;
	const clearing = abortLogExports().then(() => {
		settled = true;
	});
	try {
		await aborted.promise;
		release.resolve();
		expect(await building).toEqual({ ok: false, error: "READ_FAILED" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(true);
	} finally {
		release.resolve();
		await building;
		if (settled) await clearing;
	}
});

test("a download delivers its declared records and then closes each read", async () => {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	if (!response.body) throw new Error("missing bundle body");
	const reader = response.body.getReader();
	let reading = Promise.resolve();
	try {
		// Exporter, stored boot, settings and end are four complete gzip members.
		for (let member = 0; member < 5; member++) {
			let outcome = "pending";
			reading = reader.read().then(
				(value) => {
					outcome = value.done ? "closed" : "member";
				},
				(error: unknown) => {
					outcome = error instanceof Error ? error.message : String(error);
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcome).toBe(member === 4 ? "closed" : "member");
		}
	} finally {
		await reader.cancel();
		await reading;
	}
});
