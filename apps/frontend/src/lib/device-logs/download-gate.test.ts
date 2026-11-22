// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		const second = Promise.withResolvers<void>();
		const asked: string[] = [];
		const ended = requestLegacyLog(
			() => false,
			(request) => {
				asked.push(request);
				return first.promise;
			},
		);
		const live = requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return second.promise;
			},
		);

		expect(deliverLegacyLog({ ...FILE, request: asked[0] })).toBe(false);
		expect(deliverLegacyLog({ ...FILE, request: asked[1] })).toBe(true);
		first.resolve();
		second.resolve();
		await Promise.all([ended, live]);

		expect(saved).toHaveLength(1);
	});

	it("saves the reopened view's file and not the closed view's, also when the later request is answered first", async () => {
		let open = true;
		const asked: string[] = [];
		const replies = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		];
		const closed = requestLegacyLog(
			() => open,
			(request) => {
				asked.push(request);
				return replies[0]?.promise ?? Promise.resolve();
			},
		);
		open = false;
		const reopened = requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return replies[1]?.promise ?? Promise.resolve();
			},
		);

		expect(
			deliverLegacyLog({
				...FILE,
				contents: "reopened view",
				request: asked[1],
			}),
		).toBe(true);
		replies[1]?.resolve();
		expect(
			deliverLegacyLog({ ...FILE, contents: "closed view", request: asked[0] }),
		).toBe(false);
		replies[0]?.resolve();
		await Promise.all([closed, reopened]);

		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"reopened view",
		]);
	});

	it("lets an unanswered request claim its late file only until its window ends, and never another request's", async () => {
		vi.useFakeTimers();
		const asked: string[] = [];
		const answer = Promise.withResolvers<void>();
		await requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return Promise.reject(new Error("timed out"));
			},
		).catch(() => undefined);
		const next = requestLegacyLog(
			() => true,
			(request) => {
				asked.push(request);
				return answer.promise;
			},
		);

		expect(deliverLegacyLog({ ...FILE, contents: "whose" })).toBe(false);
		await vi.advanceTimersByTimeAsync(LATE_FILE_MS);
		expect(
			deliverLegacyLog({ ...FILE, contents: "too late", request: asked[0] }),
		).toBe(false);
		expect(
			deliverLegacyLog({ ...FILE, contents: "its own", request: asked[1] }),
		).toBe(true);
		answer.resolve();
		await next;

		expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual([
			"its own",
		]);
	});
});
