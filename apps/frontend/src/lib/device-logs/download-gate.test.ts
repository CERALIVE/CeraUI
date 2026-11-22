// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallTimeoutError } from "$lib/rpc/rpc-timeouts";
import {
	deliverLegacyLog,
	LATE_FILE_MS,
	requestLegacyLog,
	startBackendDownload,
} from "./download-gate";

const FILE = { name: "ceralive_log.txt", contents: "  first \n\n second\n" };

let saved: { name: string; href: string }[];
let blobs: Blob[];

beforeEach(() => {
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
		await requestLegacyLog(
			() => true,
			() => Promise.resolve(),
		);

		expect(deliverLegacyLog(FILE)).toBe(false);
		expect(saved).toEqual([]);
	});

	it("goes to its own request by the id the device echoes, each checked against its own open", async () => {
		const first = Promise.withResolvers<void>();
		const asked: string[] = [];
		let open = true;
		const ended = requestLegacyLog(
			() => open,
			(request) => {
				asked.push(request);
				return first.promise;
			},
		);
		const live = requestLegacyLog(
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
				() => open,
				(request) => {
					asked.push(request);
					return closedReply.promise;
				},
			);
			open = false;
			const reopened = requestLegacyLog(
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

	it("holds the next request until a timed-out request's window ends, then sends it and saves its own file", async () => {
		vi.useFakeTimers();
		const asked: string[] = [];
		await requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new CallTimeoutError("Request timeout"));
			},
		).catch(() => undefined);
		const next = requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve(
					expect(
						deliverLegacyLog({ ...FILE, contents: "its own", request }),
					).toBe(true),
				);
			},
		);

		await vi.advanceTimersByTimeAsync(LATE_FILE_MS - 1);
		expect(asked).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await next;

		expect(asked).toHaveLength(2);
		expect(
			deliverLegacyLog({ ...FILE, contents: "too late", request: asked[0] }),
		).toBe(false);
		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"its own",
		]);
	});

	it("sends the next request at once after a failure that sends no file", async () => {
		const asked: string[] = [];
		await requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new Error("socket closed"));
			},
		).catch(() => undefined);
		await requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return Promise.resolve();
			},
		);

		expect(asked).toHaveLength(2);
	});
});
