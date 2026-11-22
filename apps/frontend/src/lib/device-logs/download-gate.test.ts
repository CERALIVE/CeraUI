// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	deliverLegacyLog,
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
			() => Promise.resolve(expect(deliverLegacyLog(FILE)).toBe(true)),
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

	it("goes to its own request, oldest first, each checked against its own open", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const ended = requestLegacyLog(
			() => false,
			() => first.promise,
		);
		const live = requestLegacyLog(
			() => true,
			() => second.promise,
		);

		expect(deliverLegacyLog(FILE)).toBe(false);
		expect(deliverLegacyLog(FILE)).toBe(true);
		first.resolve();
		second.resolve();
		await Promise.all([ended, live]);

		expect(saved).toHaveLength(1);
	});
});
