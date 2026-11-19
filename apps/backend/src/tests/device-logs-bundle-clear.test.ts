import { afterEach, expect, spyOn, test } from "bun:test";
import type { LogBundleManifest, LogExportOutput } from "@ceraui/rpc/schemas";
import {
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

test.each([
	["creation", () => createBundle({})],
	["preview", () => previewBundle()],
] as const)(
	"bundle %s waits to collect until clear reopens admission",
	async (_name, prepare) => {
		h = historyFixture(false);
		const collect = spyOn(data, "collectBundleData");
		const held = await h.holdQuery();
		const clearing = h.own(clearAll());
		try {
			await bounded(held.gate.entered);
			const preparation = h.own<LogBundleManifest | LogExportOutput>(prepare());
			await turn();
			expect(collect).not.toHaveBeenCalled();
			held.gate.release();
			expect((await bounded(clearing)).ok).toBe(true);
			const result = await bounded(preparation);
			if ("ok" in result) {
				if (!result.ok) throw new Error(result.error);
				const response = await handleLogBundleRequest(
					new Request(`http://device${result.url}`),
				);
				if (!response.body) throw new Error("missing bundle download");
				const text = await bounded(
					new Response(
						response.body.pipeThrough(new DecompressionStream("gzip")),
					).text(),
				);
				expect(text).not.toContain("before-clear");
				expect(text).toContain("device logs cleared");
			} else {
				expect(
					result.sections.find((section) => section.id === "journal")?.entries,
				).toBe(1);
			}
		} finally {
			held.gate.release();
			await bounded(clearing);
			collect.mockRestore();
		}
	},
);

test("bundle redemption waits through clear and returns no old bytes", async () => {
	h = historyFixture(false);
	const ticket = await createBundle({});
	if (!ticket.ok) throw new Error(ticket.error);
	const held = await h.holdQuery();
	const clearing = h.own(clearAll());
	try {
		await bounded(held.gate.entered);
		let settled = false;
		const redemption = h.own(
			handleLogBundleRequest(new Request(`http://device${ticket.url}`)).then(
				(response) => {
					settled = true;
					return response;
				},
			),
		);
		await turn();
		expect(settled).toBe(false);
		held.gate.release();
		expect((await bounded(clearing)).ok).toBe(true);
		const response = await bounded(redemption);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("");
	} finally {
		held.gate.release();
		await bounded(clearing);
	}
});

test("bundle preparation deadline ends its wait behind clear", async () => {
	h = historyFixture(false);
	const held = await h.holdQuery();
	const clearing = h.own(clearAll());
	const timers = spyOn(globalThis, "setTimeout");
	try {
		await bounded(held.gate.entered);
		const preparation = h.own(createBundle({}));
		const fire = timers.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
		if (typeof fire !== "function")
			throw new Error("missing preparation deadline");
		fire();
		let result: unknown;
		void preparation.then((value) => {
			result = value;
		});
		await turn();
		expect(result).toEqual({ ok: false, error: "READ_FAILED" });
	} finally {
		timers.mockRestore();
		held.gate.release();
		await bounded(clearing);
	}
});
