import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as atomic from "../helpers/config-loader.ts";
import * as state from "../modules/device-logs/settings.ts";
import { historyFixture, turn } from "./helpers/history-clear.ts";

const write = atomic.writeFileAtomicSync;
let h: ReturnType<typeof historyFixture>;
beforeEach(() => {
	h = historyFixture(true);
});
afterEach(async () => {
	await h.dispose();
});

test("the clear gate becomes visible only after the synchronous epoch write succeeds", async () => {
	const before = state.getLogState().historyEpoch;
	const saving = spyOn(atomic, "writeFileAtomicSync").mockImplementation(
		(path, data) => {
			expect(state.historyClearing()).toBeNull();
			write(path, data);
		},
	);
	let reopen: (() => void) | undefined;
	try {
		reopen = state.beginHistoryClear();
		expect(state.getLogState().historyEpoch).toBe(before + 1);
		expect(
			JSON.parse(readFileSync(join(h.f.dir, "log-state.json"), "utf8"))
				.historyEpoch,
		).toBe(before + 1);
		const waiting = state.historyClearing();
		expect(waiting).toBeInstanceOf(Promise);
		let settled = false;
		const completion = waiting?.then(() => {
			settled = true;
		});
		await turn();
		expect(settled).toBe(false);
		expect(reopen()).toBeUndefined();
		await completion;
		expect(settled).toBe(true);
		expect(state.historyClearing()).toBeNull();
	} finally {
		saving.mockRestore();
		reopen?.();
	}
});

test("a failed epoch write leaves the old epoch and an open door", () => {
	const before = state.getLogState();
	const saving = spyOn(atomic, "writeFileAtomicSync").mockImplementationOnce(
		() => {
			throw new Error("full disk");
		},
	);
	try {
		expect(() => state.beginHistoryClear()).toThrow("full disk");
		expect(state.getLogState()).toEqual(before);
		expect(state.historyClearing()).toBeNull();
	} finally {
		saving.mockRestore();
	}
});

test("an old reopen callback cannot open a subsequent clear or resolve its waiters", async () => {
	const first = state.beginHistoryClear();
	const old = state.historyClearing();
	first();
	await old;
	const second = state.beginHistoryClear();
	const current = state.historyClearing();
	try {
		first();
		expect(state.historyClearing()).toBe(current);
		expect(state.getLogState().historyEpoch).toBe(2);
		second();
		await current;
		second();
		expect(state.historyClearing()).toBeNull();
	} finally {
		second();
	}
});
