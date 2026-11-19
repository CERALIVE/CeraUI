import { afterEach, expect, spyOn, test } from "bun:test";
import * as timers from "node:timers";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import { emitEvent, resetEventEmitterForTest } from "../modules/events/emit.ts";

const nativeSetTimeout = timers.setTimeout;
const nativeClearTimeout = timers.clearTimeout;
const handles: ReturnType<typeof timers.setTimeout>[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
	resetEventEmitterForTest();
	for (const restore of restores.splice(0).reverse()) restore();
	for (const handle of handles.splice(0)) nativeClearTimeout(handle);
});

function scheduler() {
	const callbacks: (() => void)[] = [];
	const schedule = spyOn(timers, "setTimeout").mockImplementation(
		Object.assign((...args: Parameters<typeof timers.setTimeout>) => {
			const [fn, , ...rest] = args;
			callbacks.push(() => fn(...rest));
			const handle = nativeSetTimeout(() => {}, 60_000);
			handles.push(handle);
			return handle;
		}, nativeSetTimeout),
	);
	const cancel = spyOn(timers, "clearTimeout");
	restores.push(
		() => schedule.mockRestore(),
		() => cancel.mockRestore(),
	);
	const stored: DeviceEvent[] = [];
	let now = 0;
	resetEventEmitterForTest({
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => 0,
		now: () => now,
		appendEvent: (event) => stored.push(event),
		log: () => {},
		warn: () => {},
	});
	return {
		callbacks,
		stored,
		schedule,
		cancel,
		advance: () => {
			now = 30_000;
		},
	};
}

test("the default emitter scheduler is invisible to global timer spies", () => {
	const h = scheduler();
	const globalSchedule = spyOn(globalThis, "setTimeout");
	const globalCancel = spyOn(globalThis, "clearTimeout");
	restores.push(
		() => globalSchedule.mockRestore(),
		() => globalCancel.mockRestore(),
	);

	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	resetEventEmitterForTest();

	expect(globalSchedule).not.toHaveBeenCalled();
	expect(globalCancel).not.toHaveBeenCalled();
	expect(h.schedule).toHaveBeenCalledTimes(1);
	expect(h.stored).toHaveLength(1);
});

test("the default native scheduler fires the latest trailing record at the coalescing deadline", () => {
	const h = scheduler();
	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	emitEvent("link_down", { iface: "eth0", kind: "ethernet", downSec: 2 });
	emitEvent("link_down", { iface: "eth0", kind: "ethernet", downSec: 3 });
	expect(h.callbacks).toHaveLength(1);
	expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);

	h.advance();
	h.callbacks[0]?.();

	expect(
		h.stored.map(({ code, params, suppressed }) => ({
			code,
			params,
			suppressed,
		})),
	).toEqual([
		{
			code: "link_down",
			params: { iface: "eth0", kind: "ethernet" },
			suppressed: undefined,
		},
		{
			code: "link_down",
			params: { iface: "eth0", kind: "ethernet", downSec: 3 },
			suppressed: 2,
		},
	]);
});

test("reset cancels the default native handle and invalidates a queued trailing callback", () => {
	const h = scheduler();
	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	emitEvent("link_down", { iface: "eth0", kind: "ethernet", downSec: 3 });
	expect(h.callbacks).toHaveLength(1);

	resetEventEmitterForTest();
	h.advance();
	h.callbacks[0]?.();

	expect(h.cancel).toHaveBeenCalledWith(handles[0]);
	expect(h.stored).toHaveLength(1);
});
