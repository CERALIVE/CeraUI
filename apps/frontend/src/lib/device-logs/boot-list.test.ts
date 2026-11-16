import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcError } from "$lib/rpc/rpc-error";

import { fourBoots } from "./__fixtures__/boots";
import { BootList, canListBoots } from "./boot-list.svelte";

afterEach(() => {
	vi.restoreAllMocks();
});

function quietErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("BootList", () => {
	it("has no boots and no failure before it reads", () => {
		const read = vi.fn<() => Promise<LogBootInfo[]>>();
		const list = new BootList(read);

		expect(list.boots).toBeNull();
		expect(list.failed).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});

	it("has no boots and no failure before the first reply", () => {
		const list = new BootList(() => new Promise<LogBootInfo[]>(() => {}));
		void list.load();

		expect(list.boots).toBeNull();
		expect(list.failed).toBe(false);
	});

	it("holds the device's boots once they arrive", async () => {
		const boots = fourBoots();
		const list = new BootList(() => Promise.resolve(boots));

		await list.load();

		expect(list.boots).toBe(boots);
		expect(list.failed).toBe(false);
	});

	it("fails with no boots when the first read fails, and reports it", async () => {
		const error = quietErrors();
		const failure = new Error("JOURNAL_UNAVAILABLE");
		const list = new BootList(() => Promise.reject(failure));

		await list.load();

		expect(list.boots).toBeNull();
		expect(list.failed).toBe(true);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs boot list failed to load:",
			failure,
		);
	});

	it("contains a read that throws before it returns a promise", async () => {
		quietErrors();
		const list = new BootList(() => {
			throw new TypeError("rpc.logs is undefined");
		});

		await list.load();

		expect(list.failed).toBe(true);
	});

	it("keeps the last good boots when a later read fails", async () => {
		quietErrors();
		const boots = fourBoots();
		const read = vi
			.fn<() => Promise<LogBootInfo[]>>()
			.mockResolvedValueOnce(boots)
			.mockRejectedValueOnce(new Error("READ_FAILED"));
		const list = new BootList(read);

		await list.load();
		await list.load();

		expect(list.boots).toBe(boots);
		expect(list.failed).toBe(true);
	});

	it("clears the failure as soon as it reads again, and keeps it clear on success", async () => {
		quietErrors();
		const boots = fourBoots();
		const retry = Promise.withResolvers<LogBootInfo[]>();
		const read = vi
			.fn<() => Promise<LogBootInfo[]>>()
			.mockRejectedValueOnce(new Error("READ_FAILED"))
			.mockReturnValueOnce(retry.promise);
		const list = new BootList(read);
		await list.load();

		const again = list.load();
		expect(list.failed).toBe(false);
		retry.resolve(boots);
		await again;

		expect(list.boots).toBe(boots);
		expect(list.failed).toBe(false);
	});

	it("ignores a reply that arrives after a newer read started", async () => {
		const stale = Promise.withResolvers<LogBootInfo[]>();
		const fresh = fourBoots().slice(0, 1);
		const read = vi
			.fn<() => Promise<LogBootInfo[]>>()
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce(fresh);
		const list = new BootList(read);

		const first = list.load();
		await list.load();
		stale.resolve(fourBoots());
		await first;

		expect(list.boots).toBe(fresh);
	});

	it("ignores a failure that arrives after a newer read succeeded", async () => {
		const error = quietErrors();
		const stale = Promise.withResolvers<LogBootInfo[]>();
		const fresh = fourBoots();
		const read = vi
			.fn<() => Promise<LogBootInfo[]>>()
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce(fresh);
		const list = new BootList(read);

		const first = list.load();
		await list.load();
		stale.reject(new Error("READ_FAILED"));
		await first;

		expect(list.boots).toBe(fresh);
		expect(list.failed).toBe(false);
		expect(error).not.toHaveBeenCalled();
	});
});

describe("canListBoots", () => {
	const copy = () => Promise.resolve();

	it("offers the boot picker once its copy loaded and the device listed its boots", async () => {
		expect(await canListBoots(copy, () => Promise.resolve(fourBoots()))).toBe(
			true,
		);
	});

	it("still offers it when the list failed for another reason, so the picker can retry", async () => {
		const timeout = new RpcError({
			message: "Request timeout: logs.boots",
			code: "INTERNAL_ERROR",
		});
		expect(await canListBoots(copy, () => Promise.reject(timeout))).toBe(true);
	});

	it("does not offer it on a device version without the boot list", async () => {
		const missing = new RpcError({
			message: "Unknown procedure path: logs.boots",
			code: "INTERNAL_ERROR",
		});
		expect(await canListBoots(copy, () => Promise.reject(missing))).toBe(false);
	});

	it("does not offer it to a client without the logs procedures", async () => {
		const read = () => {
			throw new TypeError(
				"Cannot read properties of undefined (reading 'boots')",
			);
		};
		expect(await canListBoots(copy, read)).toBe(false);
	});

	it("does not offer it, and reports why, when its copy cannot load", async () => {
		const error = quietErrors();
		const failure = new Error("chunk fetch failed");

		const offered = await canListBoots(
			() => Promise.reject(failure),
			() => Promise.resolve(fourBoots()),
		);

		expect(offered).toBe(false);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs boot picker could not load its copy:",
			failure,
		);
	});
});
