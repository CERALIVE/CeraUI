import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { call } from "@orpc/server";
import { queryLogs } from "../modules/device-logs/query.ts";
import {
	abortLogQueries,
	withQuerySlot,
} from "../modules/device-logs/query-admission.ts";
import {
	beginHistoryClear,
	getLogState,
	setLogSettingsDirForTest,
} from "../modules/device-logs/settings.ts";
import { closeSocketSession } from "../rpc/context.ts";
import {
	aroundLogsProcedure,
	queryLogsProcedure,
} from "../rpc/procedures/logs.procedure.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { latch } from "./helpers/history-clear.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

let fixture: ReturnType<typeof queryFixture>;
let sockets: Awaited<ReturnType<typeof logsSockets>>;
let timeout: AbortController;
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

beforeEach(async () => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([record(1)]));
	sockets = await logsSockets();
	timeout = new AbortController();
	jest.useFakeTimers();
});

afterEach(async () => {
	closeSocketSession(sockets.ws);
	timeout.abort();
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(pending.splice(0));
	jest.useRealTimers();
	sockets.close();
	fixture.restore();
});

function own<T>(task: Promise<T>) {
	pending.push(Promise.allSettled([task]));
	return task;
}

function hold() {
	const page = latch();
	releases.push(page.release);
	return page;
}

function holdBundlePage() {
	const owner = {};
	const page = hold();
	const done = own(
		withQuerySlot(owner, page.hold, new AbortController().signal),
	);
	return { ...page, owner, done };
}

function readRaw() {
	return own(
		call(queryLogsProcedure, { boot: bootId }, { context: sockets.context }),
	);
}

function nextTurn() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function expire() {
	jest.advanceTimersByTime(3100);
}

test("Raw gets the slot at a bundle page boundary before the next bundle page", async () => {
	const current = holdBundlePage();
	const previous = holdBundlePage();
	const order: string[] = [];
	const scan = journal([record(1)]);
	fixture.scan.mockImplementation((input) => {
		order.push("raw");
		return scan(input);
	});
	await Promise.all([current.entered, previous.entered]);
	const queuedPage = own(
		withQuerySlot(
			{},
			async () => {
				order.push("waiting bundle");
			},
			timeout.signal,
		),
	);
	const raw = readRaw();
	const next = own(
		current.done.then(() =>
			withQuerySlot(
				current.owner,
				async () => {
					order.push("bundle");
				},
				timeout.signal,
			),
		),
	);
	await nextTurn();

	current.release();

	expect(await raw).toMatchObject({ ok: true, entries: [{ cursor: "s=1" }] });
	await Promise.all([queuedPage, next]);
	expect(order).toEqual(["raw", "waiting bundle", "bundle"]);
});

test("a third Raw viewer waits and then reports BUSY while two viewers hold slots", async () => {
	const first = hold();
	const second = hold();
	const scan = journal([]);
	for (const page of [first, second]) {
		fixture.scan.mockImplementationOnce(async (input) => {
			await page.hold();
			return scan(input);
		});
		void own(queryLogs({}, { boot: bootId }));
	}
	await Promise.all([first.entered, second.entered]);
	let finished = false;
	const raw = readRaw().then((result) => {
		finished = true;
		return result;
	});
	await nextTurn();
	const finishedBeforeTimeout = finished;

	expire();

	expect(await raw).toEqual({ ok: false, error: "BUSY" });
	expect(finishedBeforeTimeout).toBe(false);
});

test("an Around request leaves the queue with READ_FAILED when its socket closes", async () => {
	const current = holdBundlePage();
	const previous = holdBundlePage();
	await Promise.all([current.entered, previous.entered]);
	const around = own(
		call(aroundLogsProcedure, { bootId, at: 1 }, { context: sockets.context }),
	);
	await nextTurn();

	closeSocketSession(sockets.ws);

	expect(await around).toEqual({ ok: false, error: "READ_FAILED" });
	expect(fixture.scan).not.toHaveBeenCalled();
});

test("a Raw waiter cannot read after Clear advances the history epoch", async () => {
	const current = holdBundlePage();
	const previous = holdBundlePage();
	await Promise.all([current.entered, previous.entered]);
	const raw = readRaw();
	await nextTurn();

	fixture.epoch.mockReturnValue({ ...getLogState(), historyEpoch: 8 });
	const drained = own(abortLogQueries());
	expect(await raw).toEqual({ ok: false, error: "READ_FAILED" });
	expect(fixture.scan).not.toHaveBeenCalled();
	current.release();
	previous.release();
	await drained;
});

test("bundle-only timeout reports READ_FAILED and does not free either unreaped slot", async () => {
	const current = holdBundlePage();
	const previous = holdBundlePage();
	await Promise.all([current.entered, previous.entered]);
	const raw = readRaw();
	await nextTurn();

	expire();

	expect(await raw).toEqual({ ok: false, error: "READ_FAILED" });
	expect(fixture.scan).not.toHaveBeenCalled();
	expect(await withQuerySlot({}, async () => "released too early")).toEqual({
		ok: false,
		error: "BUSY",
	});
});

test("Clear fails a same-socket Raw replacement before either holder reaps", async () => {
	const directory = mkdtempSync(join(import.meta.dir, ".raw-slot-clear-"));
	fixture.epoch.mockRestore();
	setLogSettingsDirForTest(directory);
	let reopen: (() => void) | undefined;
	try {
		const reader = hold();
		const bundle = holdBundlePage();
		void own(withQuerySlot(sockets.ws, reader.hold));
		await Promise.all([reader.entered, bundle.entered]);
		let replacement: Awaited<ReturnType<typeof queryLogs>> | undefined;
		void own(
			queryLogs(
				sockets.ws,
				{ boot: bootId },
				{ interactive: timeout.signal },
			).then((result) => {
				replacement = result;
			}),
		);

		reopen = beginHistoryClear();
		let drained = false;
		const drain = own(
			abortLogQueries().then(() => {
				drained = true;
			}),
		);
		await nextTurn();

		expect(replacement).toEqual({ ok: false, error: "READ_FAILED" });
		expect(fixture.scan).not.toHaveBeenCalled();
		expect(drained).toBe(false);
		reader.release();
		await nextTurn();
		expect(drained).toBe(false);
		bundle.release();
		await drain;
	} finally {
		reopen?.();
		setLogSettingsDirForTest(null);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an older same-socket replacement reads before a later viewer once its holder reaps", async () => {
	const owner = {};
	const reader = hold();
	const other = holdBundlePage();
	const order: string[] = [];
	const viewer = { interactive: timeout.signal };
	void own(withQuerySlot(owner, reader.hold, viewer));
	await Promise.all([reader.entered, other.entered]);
	const replacement = own(
		withQuerySlot(
			owner,
			async () => {
				order.push("replacement");
			},
			viewer,
		),
	);
	const later = own(
		withQuerySlot(
			{},
			async () => {
				order.push("later viewer");
			},
			viewer,
		),
	);
	await nextTurn();
	expect(order).toEqual([]);

	reader.release();

	await Promise.all([replacement, later]);
	expect(order).toEqual(["replacement", "later viewer"]);
});

test("the oldest download gets the third handoff even while more viewers wait", async () => {
	const first = holdBundlePage();
	const other = holdBundlePage();
	await Promise.all([first.entered, other.entered]);
	const order: string[] = [];
	const viewer = { interactive: timeout.signal };
	const queue = (
		label: string,
		signal: AbortSignal | typeof viewer,
		page?: ReturnType<typeof hold>,
	) =>
		own(
			withQuerySlot(
				{},
				async () => {
					order.push(label);
					await page?.hold();
				},
				signal,
			),
		);
	const download = hold();
	const oldest = queue("oldest download", timeout.signal, download);
	const newer = queue("newer download", timeout.signal);
	const one = hold();
	const two = hold();
	const three = hold();

	const firstViewer = queue("viewer 1", viewer, one);
	first.release();
	await nextTurn();
	const secondViewer = queue("viewer 2", viewer, two);
	one.release();
	await nextTurn();
	const thirdViewer = queue("viewer 3", viewer, three);
	two.release();
	await nextTurn();

	expect(order).toEqual(["viewer 1", "viewer 2", "oldest download"]);
	three.release();
	download.release();
	await Promise.all([oldest, newer, firstViewer, secondViewer, thirdViewer]);
	expect(order).toEqual([
		"viewer 1",
		"viewer 2",
		"oldest download",
		"viewer 3",
		"newer download",
	]);
});
