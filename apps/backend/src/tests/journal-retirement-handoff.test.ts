import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import { setMutationBlockDeps } from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	mutationSlotName,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	isModemMutationHeld,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	deferred,
	JournalRetryClock,
} from "./helpers/journal-reconciliation-harness.ts";
import { useReplayHarness } from "./helpers/journal-replay-harness.ts";
import { journalBytes } from "./helpers/journal-retirement-harness.ts";
import { seedRetirement } from "./helpers/retirement-exclusion-harness.ts";

type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

const harness = useReplayHarness();
function observeWait(signal: AbortSignal) {
	const entered = deferred(),
		add = signal.addEventListener.bind(signal);
	const listener = spyOn(signal, "addEventListener").mockImplementation(
		(
			type: string,
			callback: AbortListener,
			options?: Parameters<AbortSignal["addEventListener"]>[2],
		) => {
			add(type, callback, options);
			if (type === "abort") entered.release();
		},
	);
	return { entered: entered.promise, listener };
}

test("an eligible failed fallback waits for its mutation tail before acknowledgement can unlink", async () => {
	// Given the executed D2 counterexample: arming EIO, durable failed bookkeeping and held presence refresh.
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	const entered = deferred(),
		hold = deferred();
	let writes = 0,
		unlinks = 0,
		effects = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			writeTemp: async (path, data) => {
				if (++writes === 1)
					throw Object.assign(new Error("arming EIO"), { code: "EIO" });
				await defaultMutationJournalFs.writeTemp(path, data);
			},
			unlink: async (path) => {
				if (path.endsWith(".json")) unlinks++;
				await defaultMutationJournalFs.unlink(path);
			},
		},
	});
	setMutationBlockDeps({
		presentStableKeys: async () => {
			entered.release();
			await hold.promise;
			return new Set(["usb:b"]);
		},
	});
	const mutation = withJournaledModemMutation(
		"usb:b",
		"usb-mode",
		{ mode: "qmi" },
		async () => {
			effects++;
			return { confirmed: true, value: 1 };
		},
	);
	const controller = new AbortController(),
		wait = observeWait(controller.signal);
	let acknowledgement: ReturnType<typeof acknowledgeMutation> | undefined;
	try {
		await entered.promise;
		const bytes = journalBytes(harness.root());
		expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
		// The fallback's preState is the caller's request, not captured hardware, so the operator accepts current state.
		acknowledgement = acknowledgeMutation(
			"usb:b",
			"force-rebaseline",
			controller.signal,
		);
		// When the eligible operator sees the still-owned tail, no deletion may precede lease settlement.
		await Promise.race([wait.entered, acknowledgement]);
		expect(unlinks).toBe(0);
		expect(journalBytes(harness.root())).toEqual(bytes);
		expect(isModemMutationHeld("usb:b")).toBe(true);
		expect(effects).toBe(0);
		hold.release();
		expect(await mutation).toEqual({ ok: false, refusal: "mutation_blocked" });
		// Then the operator rereads after the tail and retires the same eligible authority.
		expect(await acknowledgement).toEqual({
			success: true,
			state: "acknowledged",
		});
		expect(unlinks).toBe(1);
		expect(await readMutationEntry("usb:b")).toBeUndefined();
		expect(isModemMutationHeld("usb:b")).toBe(false);
	} finally {
		hold.release();
		controller.abort();
		await mutation;
		await acknowledgement;
		wait.listener.mockRestore();
	}
});

test("an aborted eligible retirement wait returns without deleting or releasing its holder", async () => {
	// Given eligible authority whose existing key lease is held independently.
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	await seedRetirement("acknowledged");
	const acquired = tryAcquireModemMutation("usb:b");
	if (!acquired.admitted) throw new Error("fixture lease refused");
	const controller = new AbortController(),
		wait = observeWait(controller.signal);
	const before = journalBytes(harness.root());
	const result = acknowledgeMutation(
		"usb:b",
		"verified-rollback",
		controller.signal,
	);
	try {
		await Promise.race([wait.entered, result]);
		// When cancellation ends the waiter, it cannot submit the pending retirement.
		controller.abort();
		expect(await result).toEqual({ success: false, error: "state_mismatch" });
		// Then the holder and the literal bytes remain untouched.
		expect(isModemMutationHeld("usb:b")).toBe(true);
		expect(journalBytes(harness.root())).toEqual(before);
	} finally {
		controller.abort();
		acquired.lease.release();
		await result;
		wait.listener.mockRestore();
	}
});

test("three eligible acquisition attempts cap a pathological holder chain without a third wait", async () => {
	// Given real leases inserted at each actual slot read, not a fake lease reducer.
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	await seedRetirement("acknowledged");
	const slot = join(harness.root(), `${mutationSlotName("usb:b")}.json`);
	const arrivals = [deferred(), deferred(), deferred()];
	const holders: { release(): void }[] = [];
	let reads = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				const value = await defaultMutationJournalFs.readText(path);
				if (path === slot) {
					const acquired = tryAcquireModemMutation("usb:b");
					if (!acquired.admitted)
						throw new Error("chain fixture lease refused");
					holders.push(acquired.lease);
					arrivals[reads++]?.release();
				}
				return value;
			},
		},
	});
	const controller = new AbortController(),
		wait = observeWait(controller.signal);
	const result = acknowledgeMutation(
		"usb:b",
		"verified-rollback",
		controller.signal,
	);
	try {
		for (let i = 0; i < 2; i++) {
			await Promise.race([arrivals[i]?.promise, result]);
			await Promise.resolve();
			await Promise.resolve();
			expect(wait.listener.mock.calls.length).toBe(i + 1);
			holders[i]?.release();
		}
		// When a third eligible holder replaces the prior two, no further wait is allocated.
		await Promise.race([arrivals[2]?.promise, result]);
		await Promise.resolve();
		await Promise.resolve();
		expect(wait.listener.mock.calls.length).toBe(2);
		expect(await result).toEqual({ success: false, error: "state_mismatch" });
		// Then the bounded decision leaves durable authority and the last holder intact.
		expect(reads).toBe(3);
		expect(isModemMutationHeld("usb:b")).toBe(true);
	} finally {
		controller.abort();
		for (const holder of holders) holder.release();
		await result;
		wait.listener.mockRestore();
	}
});
