import type { LogQueryInput } from "@ceraui/rpc/schemas";
import { describe, expect, it, vi } from "vitest";

import { EXPORT_TICKET } from "./__fixtures__/sharing";
import { RAW_OPENING_QUERY } from "./sharing";
import { SharingFlow } from "./sharing-flow.svelte";

const FILTER: LogQueryInput = {
	sources: ["network"],
	levels: ["error"],
	text: "packet",
	boot: "all",
	since: 123,
	until: 456,
};

function flow() {
	const createExport = vi.fn().mockResolvedValue(EXPORT_TICKET);
	return {
		createExport,
		view: new SharingFlow({
			current: () => true,
			logs: { createExport, previewBundle: vi.fn(), createBundle: vi.fn() },
			download: vi.fn(),
		}),
	};
}

describe("SharingFlow Raw-view publisher ownership", () => {
	it("retains the last query for export from Storage, but a detached publisher cannot replace it", async () => {
		const { view, createExport } = flow();
		try {
			const publisher = view.bindView();
			publisher.publish(FILTER);
			publisher.dispose();
			publisher.dispose();
			publisher.publish(RAW_OPENING_QUERY);
			view.openExport();
			await view.confirmExport();

			expect(createExport).toHaveBeenCalledExactlyOnceWith({
				filter: { sources: ["network"], levels: ["error"], text: "packet" },
				boot: "all",
				since: 123,
				until: 456,
			});
		} finally {
			view.dispose();
		}
	});

	it("a stale publisher cannot clear or overwrite a newer Raw view's query", () => {
		const { view } = flow();
		try {
			const old = view.bindView();
			const current = view.bindView();
			current.publish(FILTER);
			old.dispose();
			old.publish(RAW_OPENING_QUERY);

			expect(view.view).toEqual(FILTER);
			current.publish({ ...FILTER, text: "current" });
			expect(view.view.text).toBe("current");
		} finally {
			view.dispose();
		}
	});

	it("clears the snapshot and every publisher when the whole logs view is disposed", () => {
		const { view } = flow();
		const publisher = view.bindView();
		publisher.publish(FILTER);

		view.dispose();
		view.dispose();
		publisher.publish(FILTER);
		const late = view.bindView();
		late.publish(FILTER);
		expect(view.view).toEqual(RAW_OPENING_QUERY);
	});
});
