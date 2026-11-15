import { afterEach, expect, spyOn, test } from "bun:test";
import * as atomic from "../helpers/config-loader.ts";
import { getRecentLogLines, logger } from "../helpers/logger.ts";
import * as exports from "../modules/device-logs/export.ts";
import * as retention from "../modules/device-logs/retention.ts";
import * as files from "../modules/device-logs/retention-files.ts";
import * as settings from "../modules/device-logs/settings.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});
for (const mock of [false, true]) {
	test(`ticket consumption during a ${mock ? "mock" : "native"} clear waits without stealing the old reservation`, async () => {
		h = historyFixture(mock);
		const ticket = await exports.createExport({}, { filter: {} });
		if (!ticket.ok) throw new Error(ticket.error);
		const held = await h.holdQuery();
		const clearing = h.own(retention.clearAll());
		try {
			await bounded(held.gate.entered);
			let consumed = false;
			const consumption = h.own(
				exports
					.handleLogExportRequest(new Request(`http://device${ticket.url}`))
					.then((response) => {
						consumed = true;
						return response;
					}),
			);
			let created = false;
			const next = h.own(
				exports.createExport({}, { filter: {} }).then((result) => {
					created = true;
					return result;
				}),
			);
			await turn();
			expect(consumed).toBe(false);
			expect(created).toBe(false);
			held.gate.release();
			expect((await bounded(clearing)).ok).toBe(true);
			const response = await bounded(consumption);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("");
			expect((await bounded(next)).ok).toBe(true);
		} finally {
			held.gate.release();
		}
	});
	test(`back to back ${mock ? "mock" : "native"} clears keep waiting admissions owned by the right run`, async () => {
		h = historyFixture(mock);
		const gate = h.ownedLatch();
		const real = files.deleteLegacyDebugFiles;
		let calls = 0;
		const remove = spyOn(files, "deleteLegacyDebugFiles").mockImplementation(
			async (...args) => {
				if (++calls === 2) await gate.hold();
				return real(...args);
			},
		);
		const first = h.own(retention.clearAll());
		const second = h.own(retention.clearAll());
		try {
			await bounded(gate.entered);
			expect((await bounded(first)).ok).toBe(true);
			let settled = false;
			const incoming = h.own(
				exports.createExport({}, { filter: {} }).then((result) => {
					settled = true;
					return result;
				}),
			);
			await turn();
			expect(settled).toBe(false);
			gate.release();
			expect((await bounded(second)).ok).toBe(true);
			expect((await bounded(incoming)).ok).toBe(true);
			expect(settings.getLogState().historyEpoch).toBe(2);
		} finally {
			gate.release();
			await bounded(Promise.allSettled([first, second]));
			remove.mockRestore();
		}
	});
	test(`an export admitted between ${mock ? "mock" : "native"} clears is revoked by the second gate`, async () => {
		h = historyFixture(mock);
		const firstGate = h.holdReadout();
		const first = h.own(retention.clearAll());
		try {
			await bounded(firstGate.entered);
			let created = false;
			const between = h.own(
				exports.createExport({}, { filter: {} }).then((value) => {
					created = true;
					return value;
				}),
			);
			await turn();
			expect(created).toBe(false);
			firstGate.release();
			expect((await bounded(first)).ok).toBe(true);
			const ticket = await bounded(between);
			if (!ticket.ok) throw new Error(ticket.error);
			const secondGate = h.holdUnlink();
			const second = h.own(retention.clearAll());
			try {
				await bounded(secondGate.entered);
				let consumed = false;
				const response = h.own(
					exports
						.handleLogExportRequest(new Request(`http://device${ticket.url}`))
						.then((value) => {
							consumed = true;
							return value;
						}),
				);
				await turn();
				expect(consumed).toBe(false);
				secondGate.release();
				expect((await bounded(second)).ok).toBe(true);
				expect((await bounded(response)).status).toBe(403);
				expect((await exports.createExport({}, { filter: {} })).ok).toBe(true);
				expect(settings.getLogState().historyEpoch).toBe(2);
			} finally {
				secondGate.release();
			}
		} finally {
			firstGate.release();
		}
	});
	test(`failed epoch persistence before a ${mock ? "mock" : "native"} clear aborts nothing and leaves the door open`, async () => {
		h = historyFixture(mock);
		const ticket = await exports.createExport({}, { filter: {} });
		if (!ticket.ok) throw new Error(ticket.error);
		const before = settings.getLogState();
		const write = spyOn(atomic, "writeFileAtomicSync").mockImplementationOnce(
			() => {
				throw new Error("disk full");
			},
		);
		try {
			expect(await retention.clearAll()).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(settings.getLogState()).toEqual(before);
			const old = await exports.handleLogExportRequest(
				new Request(`http://device${ticket.url}`),
			);
			expect(await bounded(old.text())).toContain("before-clear");
			expect((await exports.createExport({}, { filter: {} })).ok).toBe(true);
			expect(
				h.f.run.mock.calls.filter(([, args]) => args.includes("--rotate")),
			).toEqual([]);
		} finally {
			write.mockRestore();
		}
	});
	test(`an update starting during ${mock ? "mock" : "native"} drain refuses deletion after the bump`, async () => {
		h = historyFixture(mock);
		const before = getRecentLogLines();
		const held = await h.holdQuery();
		const clearing = h.own(retention.clearAll());
		try {
			await bounded(held.gate.entered);
			h.f.phase.mockReturnValue({ ...h.f.phase(), phase: "committing" });
			held.gate.release();
			expect(await bounded(clearing)).toEqual({
				ok: false,
				error: "UPDATE_IN_PROGRESS",
			});
			expect(settings.getLogState().historyEpoch).toBe(1);
			expect(settings.getLogState().lastClearedAt).toBeNull();
			expect(getRecentLogLines()).toEqual(before);
			expect(h.f.run.mock.calls).toEqual([]);
			expect((await exports.createExport({}, { filter: {} })).ok).toBe(true);
		} finally {
			held.gate.release();
		}
	});
	test(`an update busy before ${mock ? "mock" : "native"} clear leaves the old owner and epoch alone`, async () => {
		h = historyFixture(mock);
		const held = await h.holdQuery();
		h.f.phase.mockReturnValue({ ...h.f.phase(), phase: "committing" });
		try {
			expect(await retention.clearAll()).toEqual({
				ok: false,
				error: "UPDATE_IN_PROGRESS",
			});
			expect(settings.getLogState().historyEpoch).toBe(0);
			expect(held.child.signals).toEqual([]);
			expect(h.f.run.mock.calls).toEqual([]);
		} finally {
			held.gate.release();
			held.child.finish();
			await bounded(held.task);
		}
	});
}

test("mock clear writes its marker first despite unrelated logging during legacy unlink", async () => {
	h = historyFixture(true);
	const held = h.holdUnlink();
	const clearing = h.own(retention.clearAll());
	try {
		await bounded(held.entered);
		logger.info("during-unlink");
		held.release();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(JSON.parse(getRecentLogLines()[0] ?? "{}").msg).toBe(
			"device logs cleared",
		);
		expect(
			getRecentLogLines().some((line) => line.includes("during-unlink")),
		).toBe(false);
	} finally {
		held.release();
	}
});
