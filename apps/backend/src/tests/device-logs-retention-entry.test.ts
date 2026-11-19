import { afterEach, expect, test } from "bun:test";
import type { LogAroundOutput, LogQueryOutput } from "@ceraui/rpc/schemas";
import * as exports from "../modules/device-logs/export.ts";
import { startFollow, stopFollow } from "../modules/device-logs/follow.ts";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import * as retention from "../modules/device-logs/retention.ts";
import { bootId } from "./helpers/device-query.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";
import { historyJournal } from "./helpers/history-journal.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});
for (const mock of [false, true]) {
	for (const kind of ["query", "around"] as const) {
		test(`${kind} replacement waiting before a ${mock ? "mock" : "native"} bump closes instead of entering new history`, async () => {
			h = historyFixture(mock);
			const held = await h.holdQuery();
			const replacement = h.own<LogQueryOutput | LogAroundOutput>(
				kind === "query"
					? queryLogs(held.conn, {})
					: locateAround(held.conn, { bootId, at: Date.now() }),
			);
			await bounded(held.gate.entered);
			const clearing = h.own(retention.clearAll());
			try {
				await turn();
				held.gate.release();
				expect((await bounded(clearing)).ok).toBe(true);
				expect(await bounded(replacement)).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
			} finally {
				held.gate.release();
			}
		});
	}
	test(`follow replacement waiting before a ${mock ? "mock" : "native"} bump never becomes ready after cleared`, async () => {
		h = historyFixture(mock);
		const held = await h.holdFollow();
		let spawned = 0;
		const replacement = h.own(
			startFollow(
				held.conn,
				{},
				{
					clock: h.time.clock,
					spawn: () => {
						spawned++;
						return historyJournal().proc;
					},
				},
			),
		);
		await bounded(held.gate.entered);
		const clearing = h.own(retention.clearAll());
		try {
			await turn();
			held.gate.release();
			expect((await bounded(clearing)).ok).toBe(true);
			expect(await bounded(replacement)).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(spawned).toBe(0);
			expect(held.messages.map((message) => message.ended)).toEqual([
				"cleared",
			]);
			expect(await stopFollow(held.conn)).toEqual({
				success: false,
				checkpointCursor: null,
			});
		} finally {
			held.gate.release();
		}
	});

	for (const clearFirst of [false, true]) {
		test(`around and clear in one tick, clearFirst=${clearFirst}, mock=${mock}, abort the pending metadata caller`, async () => {
			h = historyFixture(mock);
			const gate = h.ownedLatch();
			const available = await h.list();
			h.list.mockImplementationOnce(async () => {
				await gate.hold();
				return available;
			});
			const earlier = clearFirst
				? undefined
				: h.own(locateAround({}, { bootId, at: Date.now() }));
			const clearing = h.own(retention.clearAll());
			const around =
				earlier ?? h.own(locateAround({}, { bootId, at: Date.now() }));
			try {
				await bounded(gate.entered);
				await turn();
				gate.release();
				expect(await bounded(around)).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
				expect((await bounded(clearing)).ok).toBe(true);
			} finally {
				gate.release();
			}
		});
		test(`follow and clear in one tick, clearFirst=${clearFirst}, mock=${mock}, never report readiness`, async () => {
			h = historyFixture(mock);
			const gate = h.ownedLatch();
			const baseline = h.scan.getMockImplementation();
			if (!baseline) throw new Error("missing journal transport");
			h.scan.mockImplementationOnce(async (input) => {
				const result = await baseline(input);
				await gate.hold();
				return result;
			});
			const messages: import("@ceraui/rpc/schemas").LogFollowMessage[] = [];
			const conn = h.socket(messages);
			let spawned = 0;
			const follow = () =>
				h.own(
					startFollow(
						conn,
						{},
						{
							clock: h.time.clock,
							spawn: () => {
								spawned++;
								return historyJournal().proc;
							},
						},
					),
				);
			const earlier = clearFirst ? undefined : follow();
			const clearing = h.own(retention.clearAll());
			const following = earlier ?? follow();
			try {
				await bounded(gate.entered);
				expect(messages.map((message) => message.ended)).toEqual(["cleared"]);
				gate.release();
				expect(await bounded(following)).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
				expect((await bounded(clearing)).ok).toBe(true);
				expect(spawned).toBe(0);
				expect(messages.map((message) => message.ended)).toEqual(["cleared"]);
			} finally {
				gate.release();
			}
		});
		test(`query and clear in one tick, clearFirst=${clearFirst}, mock=${mock}, never publish an old pending page`, async () => {
			h = historyFixture(mock);
			let clearing: Promise<Awaited<ReturnType<typeof retention.clearAll>>>;
			let preparing: ReturnType<typeof h.holdQuery>;
			if (clearFirst) {
				clearing = h.own(retention.clearAll());
				preparing = h.holdQuery();
			} else {
				preparing = h.holdQuery();
				clearing = h.own(retention.clearAll());
			}
			const held = await preparing;
			try {
				await bounded(held.gate.entered);
				held.gate.release();
				expect((await bounded(clearing)).ok).toBe(true);
				expect(await bounded(held.task)).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
			} finally {
				held.gate.release();
			}
		});
		test(`export and clear in one tick, clearFirst=${clearFirst}, mock=${mock}, leave no old ticket reservation`, async () => {
			h = historyFixture(mock);
			const creation = clearFirst
				? undefined
				: exports.createExport({}, { filter: {} });
			const clearing = h.own(retention.clearAll());
			const ticket = await (creation ??
				exports.createExport({}, { filter: {} }));
			expect((await bounded(clearing)).ok).toBe(true);
			if (ticket.ok) {
				const stale = await exports.handleLogExportRequest(
					new Request(`http://device${ticket.url}`),
				);
				expect(stale.status).toBe(403);
			} else expect(ticket.error).toBe("READ_FAILED");
			expect((await exports.createExport({}, { filter: {} })).ok).toBe(true);
		});
	}
}
