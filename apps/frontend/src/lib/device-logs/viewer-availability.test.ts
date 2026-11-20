import { afterEach, describe, expect, it, vi } from "vitest";

import { NotSentError, RpcError } from "$lib/rpc/rpc-error";

import { checkLogViewer, isMissingProcedure } from "./viewer-availability";

// The backend adapter's reply for a path its router does not have
// (apps/backend/src/rpc/adapter.ts): an older backend that predates logs.*.
const missingProcedure = () =>
	new RpcError({
		message: "Unknown procedure path: logs.getStorage",
		code: "INTERNAL_ERROR",
	});

const resolved = () => Promise.resolve();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isMissingProcedure", () => {
	it("recognises the backend's unknown-procedure reply", () => {
		expect(isMissingProcedure(missingProcedure())).toBe(true);
	});

	it("recognises a client without the logs procedures (rpc.logs undefined)", () => {
		const probe = () =>
			(({}) as { logs: { getStorage: () => unknown } }).logs.getStorage();
		let thrown: unknown;
		try {
			probe();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TypeError);
		expect(isMissingProcedure(thrown)).toBe(true);
	});

	it.each([
		["a timeout", new Error("Request timeout: logs.getStorage")],
		["a closed socket", new NotSentError()],
		[
			"another backend failure",
			new RpcError({ message: "journal read failed", code: "INTERNAL_ERROR" }),
		],
		[
			"the prefix inside, not at the start",
			new RpcError({
				message: "wrapped: Unknown procedure path: logs.getStorage",
				code: "INTERNAL_ERROR",
			}),
		],
		[
			"the prefix on a non-RPC error",
			new Error("Unknown procedure path: logs.getStorage"),
		],
		[
			"an empty RPC message",
			new RpcError({ message: "", code: "INTERNAL_ERROR" }),
		],
		["a string", "Unknown procedure path: logs.getStorage"],
		["undefined", undefined],
		["null", null],
	])("does not treat %s as a missing procedure", (_label, error) => {
		expect(isMissingProcedure(error)).toBe(false);
	});
});

describe("checkLogViewer", () => {
	it("is ready when the copy loads and the probe answers", async () => {
		const error = vi.spyOn(console, "error");
		const loadCopy = vi.fn(resolved);
		const probe = vi.fn(() => Promise.resolve({ journalBytes: null }));

		await expect(checkLogViewer(loadCopy, probe)).resolves.toBe("ready");
		expect(loadCopy).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(0);
	});

	it("starts the probe without waiting for the copy", async () => {
		let releaseCopy: () => void = () => {};
		const loadCopy = () =>
			new Promise<void>((resolve) => {
				releaseCopy = resolve;
			});
		const probe = vi.fn(resolved);

		const outcome = checkLogViewer(loadCopy, probe);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
		releaseCopy();
		await expect(outcome).resolves.toBe("ready");
	});

	it("is unavailable, without an error report, when the backend lacks the procedure", async () => {
		const error = vi.spyOn(console, "error");
		await expect(
			checkLogViewer(resolved, () => Promise.reject(missingProcedure())),
		).resolves.toBe("unavailable");
		expect(error).toHaveBeenCalledTimes(0);
	});

	it("is unavailable when the probe throws synchronously because the logs client is absent", async () => {
		const rpc = {} as { logs: { getStorage: () => Promise<unknown> } };
		await expect(
			checkLogViewer(resolved, () => rpc.logs.getStorage()),
		).resolves.toBe("unavailable");
	});

	it("fails and reports any other probe failure", async () => {
		const failure = new Error("Request timeout: logs.getStorage");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			checkLogViewer(resolved, () => Promise.reject(failure)),
		).resolves.toBe("failed");
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs availability check failed:",
			failure,
		);
	});

	it("fails and reports a copy that cannot load, even when the probe answers", async () => {
		const failure = new Error("chunk fetch failed");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			checkLogViewer(() => Promise.reject(failure), resolved),
		).resolves.toBe("failed");
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs availability check failed:",
			failure,
		);
	});

	it("fails on missing copy even when the backend also lacks the procedure", async () => {
		const failure = new Error("chunk fetch failed");
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			checkLogViewer(
				() => Promise.reject(failure),
				() => Promise.reject(missingProcedure()),
			),
		).resolves.toBe("failed");
	});
});
