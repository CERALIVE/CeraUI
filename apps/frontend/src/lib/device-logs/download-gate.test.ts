// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallTimeoutError } from "$lib/rpc/rpc-timeouts";
import { nextSocketEpoch } from "$lib/rpc/socket-epoch.svelte";
import {
	deliverLegacyLog,
	FILE_AFTER_REPLY_MS,
	legacyLocked,
	requestLegacyLog,
	startBackendDownload,
} from "./download-gate.svelte";

const FILE = { name: "ceralive_log.txt", contents: "  first \n\n second\n" };

let saved: { name: string; href: string }[];
let blobs: Blob[];

beforeEach(() => {
	// A fresh socket: nothing a previous case left on the old one can still be answered.
	nextSocketEpoch();
	saved = [];
	blobs = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		saved.push({ name: this.download, href: this.href });
	});
	Object.assign(URL, {
		createObjectURL: vi.fn((blob: Blob) => {
			blobs.push(blob);
			return "blob:log";
		}),
		revokeObjectURL: vi.fn(),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("download gate: a backend download", () => {
	it("reaches the browser only while the open it was issued under is live", () => {
		expect(startBackendDownload(() => true, "/api/logs/export?ticket=ab")).toBe(
			true,
		);
		expect(
			startBackendDownload(() => false, "/api/logs/export?ticket=cd"),
		).toBe(false);

		expect(saved.map(({ href }) => new URL(href).search)).toEqual([
			"?ticket=ab",
		]);
	});
});

describe("download gate: a legacy log file pushed on the socket", () => {
	it("is saved, trimmed, for a request whose open is still live", async () => {
		await requestLegacyLog(
			"device",
			() => true,
			(request) =>
				Promise.resolve(
					expect(deliverLegacyLog({ ...FILE, request })).toBe(true),
				),
		);

		expect(saved).toEqual([{ name: FILE.name, href: "blob:log" }]);
		expect(await blobs[0]?.text()).toBe("first\nsecond");
	});

	it("is not saved once the open its request was issued under has ended", async () => {
		let open = true;
		await requestLegacyLog(
			"device",
			() => open,
			() => {
				open = false;
				return Promise.resolve(expect(deliverLegacyLog(FILE)).toBe(false));
			},
		);

		expect(saved).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("is not saved when no request is waiting for it, also after one was answered without a file", async () => {
		vi.useFakeTimers();
		const answered = requestLegacyLog(
			"device",
			() => true,
			() => Promise.resolve(),
		);
		await vi.advanceTimersByTimeAsync(FILE_AFTER_REPLY_MS);
		await expect(answered).rejects.toThrow();

		expect(deliverLegacyLog(FILE)).toBe(false);
		expect(saved).toEqual([]);
	});

	it("goes to its own request by the id the device echoes, each checked against its own open", async () => {
		const first = Promise.withResolvers<void>();
		const asked: string[] = [];
		let open = true;
		const ended = requestLegacyLog(
			"device",
			() => open,
			(request) => {
				asked.push(request);
				return first.promise;
			},
		);
		const live = requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve(
					expect(deliverLegacyLog({ ...FILE, request })).toBe(true),
				);
			},
		);

		open = false;
		expect(deliverLegacyLog({ ...FILE, request: asked[0] })).toBe(false);
		first.resolve();
		await Promise.all([ended, live]);

		expect(saved).toHaveLength(1);
	});

	it.each([{ echoed: true }, { echoed: false }])(
		"keeps the reopened view's request waiting while the closed view's is outstanding, drops that file and saves its own (id echoed: $echoed)",
		async ({ echoed }) => {
			let open = true;
			const asked: string[] = [];
			const closedReply = Promise.withResolvers<void>();
			const closed = requestLegacyLog(
				"device",
				() => open,
				(request) => {
					asked.push(request);
					return closedReply.promise;
				},
			);
			open = false;
			const reopened = requestLegacyLog(
				"device",
				() => true,
				(request) => {
					asked.push(request);
					const file = { ...FILE, contents: "reopened view" };
					return Promise.resolve(
						expect(deliverLegacyLog(echoed ? { ...file, request } : file)).toBe(
							true,
						),
					);
				},
			);
			await Promise.resolve();

			expect(asked).toHaveLength(1);
			const late = { ...FILE, contents: "closed view" };
			expect(
				deliverLegacyLog(echoed ? { ...late, request: asked[0] } : late),
			).toBe(false);
			closedReply.resolve();
			await Promise.all([closed, reopened]);

			expect(asked).toHaveLength(2);
			expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
				"reopened view",
			]);
		},
	);

	it.each([{ echoed: true }, { echoed: false }])(
		"saves nothing for a timed-out request's late file, also while its open is live (id echoed: $echoed)",
		async ({ echoed }) => {
			vi.useFakeTimers();
			const asked: string[] = [];
			const failed = requestLegacyLog(
				"device",
				() => true,
				(request) => {
					asked.push(request);
					return Promise.reject(new CallTimeoutError("Request timeout"));
				},
			);

			await expect(failed).rejects.toBeInstanceOf(CallTimeoutError);
			const late = { ...FILE, contents: "late" };
			expect(
				deliverLegacyLog(echoed ? { ...late, request: asked[0] } : late),
			).toBe(false);

			expect(saved).toEqual([]);
		},
	);

	it("sends no other request after a timeout, however long it waits, until that request's late file arrives; the retry then saves only its own", async () => {
		vi.useFakeTimers();
		const asked: string[] = [];
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new CallTimeoutError("Request timeout"));
			},
		).catch(() => undefined);
		const own = (request: string) => {
			asked.push(request);
			return Promise.resolve(
				expect(deliverLegacyLog({ ...FILE, contents: "its own" })).toBe(true),
			);
		};

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await requestLegacyLog("device", () => true, own);
		expect(legacyLocked("device")).toBe(true);
		expect(asked).toHaveLength(1);
		expect(deliverLegacyLog({ ...FILE, contents: "stale" })).toBe(false);
		expect(legacyLocked("device")).toBe(false);
		await requestLegacyLog("device", () => true, own);

		expect(asked).toHaveLength(2);
		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"its own",
		]);
	});

	it("frees the downloads after a timeout once the socket is replaced, and the retry saves only its own file", async () => {
		const asked: string[] = [];
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new CallTimeoutError("Request timeout"));
			},
		).catch(() => undefined);
		expect(legacyLocked("device")).toBe(true);

		nextSocketEpoch();
		expect(legacyLocked("device")).toBe(false);
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve(
					expect(deliverLegacyLog({ ...FILE, contents: "its own" })).toBe(true),
				);
			},
		);

		expect(asked).toHaveLength(2);
		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"its own",
		]);
	});

	it("on a device that echoes the id, sends the retry at once and never gives it the timed-out request's late file, also while the retry is active", async () => {
		const asked: string[] = [];
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve(
					deliverLegacyLog({ ...FILE, contents: "first", request }),
				);
			},
		);
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new CallTimeoutError("Request timeout"));
			},
		).catch(() => undefined);
		expect(legacyLocked("device")).toBe(false);
		const retry = Promise.withResolvers<void>();
		const active = requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return retry.promise;
			},
		);

		expect(asked).toHaveLength(3);
		expect(
			deliverLegacyLog({ ...FILE, contents: "too late", request: asked[1] }),
		).toBe(false);
		expect(
			deliverLegacyLog({ ...FILE, contents: "its own", request: asked[2] }),
		).toBe(true);
		retry.resolve();
		await active;

		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"first",
			"its own",
		]);
	});

	it("sends the next request at once after a failure that sends no file", async () => {
		const asked: string[] = [];
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new Error("socket closed"));
			},
		).catch(() => undefined);
		await requestLegacyLog(
			"device",
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve(deliverLegacyLog({ ...FILE, request }));
			},
		);

		expect(asked).toHaveLength(2);
	});
});
