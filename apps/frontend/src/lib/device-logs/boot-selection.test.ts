import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOT_IDS, boot } from "./__fixtures__/boots";
import { bootSelection } from "./boot-selection.svelte";

const clean = boot(BOOT_IDS.clean, "clean");
const unclean = boot(BOOT_IDS.unclean, "unclean");

const stops: Array<() => void> = [];
function listen(listener: (bootId: string | null) => void): void {
	stops.push(bootSelection.onChoose(listener));
}

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	bootSelection.reset();
	vi.restoreAllMocks();
});

describe("bootSelection", () => {
	it("starts on All boots", () => {
		expect(bootSelection.boot).toBeNull();
		expect(bootSelection.bootId).toBeNull();
	});

	it("holds the chosen boot and tells the Events and Raw logs stores its id", () => {
		const events = vi.fn();
		const raw = vi.fn();
		listen(events);
		listen(raw);

		bootSelection.choose(clean);

		expect(bootSelection.boot).toBe(clean);
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
		expect(events).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.clean);
		expect(raw).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.clean);
	});

	it("tells the stores null when All boots is chosen again", () => {
		bootSelection.choose(clean);
		const raw = vi.fn();
		listen(raw);

		bootSelection.choose(null);

		expect(bootSelection.boot).toBeNull();
		expect(raw).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("stays quiet when the boot already chosen is chosen again", () => {
		bootSelection.choose(clean);
		const raw = vi.fn();
		listen(raw);

		bootSelection.choose(boot(BOOT_IDS.clean, "clean"));
		bootSelection.choose(clean);

		expect(raw).not.toHaveBeenCalled();
		expect(bootSelection.boot).toBe(clean);
	});

	it("stays quiet when All boots is chosen while All boots is shown", () => {
		const raw = vi.fn();
		listen(raw);

		bootSelection.choose(null);

		expect(raw).not.toHaveBeenCalled();
	});

	it("keeps telling the other stores when one throws, and reports the failure", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("store broke");
		const raw = vi.fn();
		listen(() => {
			throw failure;
		});
		listen(raw);

		bootSelection.choose(unclean);

		expect(raw).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.unclean);
		expect(bootSelection.boot).toBe(unclean);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs boot listener failed:",
			failure,
		);
	});

	it("stops telling a store once it unsubscribes", () => {
		const raw = vi.fn();
		const stop = bootSelection.onChoose(raw);
		stop();

		bootSelection.choose(clean);

		expect(raw).not.toHaveBeenCalled();
	});

	it("returns to All boots on reset without telling anyone", () => {
		bootSelection.choose(clean);
		const raw = vi.fn();
		listen(raw);

		bootSelection.reset();

		expect(bootSelection.boot).toBeNull();
		expect(bootSelection.bootId).toBeNull();
		expect(raw).not.toHaveBeenCalled();
	});
});

describe("bootSelection.recheck: after stored history is deleted", () => {
	const current = boot(BOOT_IDS.current, "current");

	it("goes back to All boots, telling the stores, when the device no longer lists the chosen boot", async () => {
		bootSelection.choose(clean);
		const raw = vi.fn();
		listen(raw);

		await bootSelection.recheck(() => Promise.resolve([current, unclean]));

		expect(bootSelection.boot).toBeNull();
		expect(raw).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("keeps a chosen boot the device still lists, telling no one", async () => {
		bootSelection.choose(clean);
		const raw = vi.fn();
		listen(raw);

		await bootSelection.recheck(() =>
			Promise.resolve([current, boot(BOOT_IDS.clean, "clean")]),
		);

		expect(bootSelection.boot).toBe(clean);
		expect(raw).not.toHaveBeenCalled();
	});

	it("reads nothing while All boots is shown", async () => {
		const read = vi.fn(() => Promise.resolve([current]));

		await bootSelection.recheck(read);

		expect(read).not.toHaveBeenCalled();
		expect(bootSelection.boot).toBeNull();
	});

	it("keeps the chosen boot and reports the failure when the boot list cannot be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("journal busy");
		bootSelection.choose(clean);

		await bootSelection.recheck(() => Promise.reject(failure));

		expect(bootSelection.boot).toBe(clean);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs could not re-check the chosen boot:",
			failure,
		);
	});

	it("contains a read that throws before it returns a promise", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new TypeError("no client");
		bootSelection.choose(clean);

		await bootSelection.recheck(() => {
			throw failure;
		});

		expect(bootSelection.boot).toBe(clean);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs could not re-check the chosen boot:",
			failure,
		);
	});

	it("leaves a boot chosen while the list was being read", async () => {
		bootSelection.choose(clean);
		const reply = Promise.withResolvers<LogBootInfo[]>();
		const recheck = bootSelection.recheck(() => reply.promise);

		bootSelection.choose(unclean);
		reply.resolve([current, unclean]);
		await recheck;

		expect(bootSelection.boot).toBe(unclean);
	});
});
