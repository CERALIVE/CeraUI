import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

for (const clearing of [false, true]) {
	test(`a real export between pages ${clearing ? "clears without another slot" : "takes a second slot normally"}`, async () => {
		h = historyFixture(false);
		for (let index = 0; index < 200; index++)
			logger.info(`page record ${index}`);
		const scanned = spyOn(pages, "scanPage");
		const created = await createExport({}, { filter: {} });
		if (!created.ok) throw new Error(created.error);
		const response = await handleLogExportRequest(
			new Request(`http://device${created.url}`),
		);
		const body = response.body?.getReader();
		if (!body) throw new Error("missing body");
		try {
			await bounded(body.read());
			for (let index = 0; index < 200; index++)
				expect((await bounded(body.read())).done).toBe(false);
			expect(scanned.mock.calls).toHaveLength(1);
			const observed = scanned.mock.results[0];
			if (observed?.type !== "return")
				throw new Error("missing completed page");
			const page = await observed.value;
			if (!page.ok) throw new Error(page.error);
			expect(page.entries).toHaveLength(200);
			expect(page.hasMore).toBe(true);
			const decoder = new TextDecoder();
			if (clearing) {
				expect((await bounded(h.own(clearAll()))).ok).toBe(true);
				expect(scanned.mock.calls).toHaveLength(1);
				expect(decoder.decode((await bounded(body.read())).value)).toBe(
					"# incomplete: cleared\n",
				);
			} else {
				expect((await bounded(body.read())).done).toBe(false);
				expect(scanned.mock.calls).toHaveLength(2);
				expect(decoder.decode((await bounded(body.read())).value)).toBe(
					"# complete: 201 entries\n",
				);
			}
			expect(await bounded(body.read())).toEqual({
				done: true,
				value: undefined,
			});
			expect((await createExport({}, { filter: {} })).ok).toBe(true);
		} finally {
			await bounded(body.cancel());
			scanned.mockRestore();
		}
	});
}
