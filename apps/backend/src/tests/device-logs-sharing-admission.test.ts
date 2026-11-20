import { expect, spyOn, test } from "bun:test";
import {
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import * as admission from "../modules/device-logs/query-admission.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";

test.each(["export", "bundle"] as const)(
	"%s preserves journal records when both viewer slots are occupied",
	async (kind) => {
		const h = historyFixture(false);
		const first = await h.holdQuery();
		await h.holdQuery();
		const attempted = Promise.withResolvers<void>();
		const original = admission.withQuerySlot;
		const slot = spyOn(admission, "withQuerySlot").mockImplementationOnce(
			(...args) => {
				const result = original(...args);
				attempted.resolve();
				return result;
			},
		);
		try {
			if (kind === "export") {
				const ticket = await createExport({}, { filter: {} });
				if (!ticket.ok) throw new Error(ticket.error);
				const response = await handleLogExportRequest(
					new Request(`http://device${ticket.url}`),
				);
				const body = h.own(response.text());
				await bounded(attempted.promise);
				first.gate.release();
				first.child.finish();
				expect(await bounded(body)).toEndWith("# complete: 1 entries\n");
				expect(await body).toContain("before-clear");
			} else {
				const created = h.own(createBundle({}));
				await bounded(attempted.promise);
				first.gate.release();
				first.child.finish();
				const ticket = await bounded(created);
				if (!ticket.ok) throw new Error(ticket.error);
				const response = await handleLogBundleRequest(
					new Request(`http://device${ticket.url}`),
				);
				if (!response.body) throw new Error("missing bundle body");
				const body = await bounded(
					new Response(
						response.body.pipeThrough(new DecompressionStream("gzip")),
					).text(),
				);
				expect(body).toContain("before-clear");
				expect(body).toEndWith('{"section":"end","complete":true}\n');
			}
		} finally {
			slot.mockRestore();
			await h.dispose();
		}
	},
);
