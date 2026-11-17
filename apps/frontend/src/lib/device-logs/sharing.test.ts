// @vitest-environment jsdom
import { LOG_ERROR_CODES } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBackendHttpUrl } from "$lib/env";
import { RpcError } from "$lib/rpc/rpc-error";

import { bundleManifest } from "./__fixtures__/sharing";
import {
	bundleManifestReply,
	chineseWordChunks,
	exportInput,
	previewProblem,
	RAW_OPENING_QUERY,
	refusal,
	startBackendDownload,
	ticketReply,
} from "./sharing";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// What the device receives: JSON drops absent optional fields.
const onWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("exportInput — the Raw logs query as an export", () => {
	it("keeps the filter, the boot and the time range, and drops paging", () => {
		expect(
			onWire(
				exportInput({
					sources: ["engine", "network"],
					levels: ["error", "warning"],
					text: "srt",
					boot: "all",
					since: 1_000,
					until: 2_000,
					direction: "newer",
					limit: 100,
					continuation: "abc",
				}),
			),
		).toStrictEqual({
			filter: {
				sources: ["engine", "network"],
				levels: ["error", "warning"],
				text: "srt",
			},
			boot: "all",
			since: 1_000,
			until: 2_000,
		});
	});

	it("sends the Raw logs tab's opening view before the tab has been read", () => {
		expect(onWire(exportInput(RAW_OPENING_QUERY))).toStrictEqual({
			filter: { sources: [], levels: ["error", "warning", "info"] },
			boot: "current",
		});
	});
});

describe("refusal — a ticket reply's error code", () => {
	it("reads BUSY as another export running", () => {
		expect(refusal("BUSY")).toBe("busy");
	});

	it.each(LOG_ERROR_CODES.filter((code) => code !== "BUSY"))(
		"reads %s as a failure",
		(code) => {
			expect(refusal(code)).toBe("failed");
		},
	);
});

describe("previewProblem — a rejected bundle preview", () => {
	it("reads the device's sanitized BUSY as another export running", () => {
		expect(
			previewProblem(new RpcError({ message: "BUSY", code: "INTERNAL_ERROR" })),
		).toBe("busy");
	});

	it.each([
		[
			"the sanitized READ_FAILED (a read error or an identifier collision)",
			new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" }),
		],
		["a reply that never arrived", new Error("Request timeout: logs.x")],
		["a plain error that only says BUSY", new Error("BUSY")],
		["a thrown non-error", "BUSY"],
	])("reads %s as a failure", (_name, error) => {
		expect(previewProblem(error)).toBe("failed");
	});
});

describe("startBackendDownload — the browser saves the file", () => {
	it("clicks an attached anchor on the backend origin, then removes it", () => {
		const clicked: Array<{
			href: string;
			download: string | null;
			connected: boolean;
		}> = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			clicked.push({
				href: this.href,
				download: this.getAttribute("download"),
				connected: this.isConnected,
			});
		});
		const path = "/api/logs/export?ticket=ab12";

		startBackendDownload(path);

		expect(clicked).toStrictEqual([
			{
				href: getBackendHttpUrl(path),
				download: "",
				connected: true,
			},
		]);
		expect(clicked[0]?.href).toMatch(
			/^https?:\/\/[^/]+\/api\/logs\/export\?ticket=ab12$/,
		);
		expect(document.querySelectorAll("a")).toHaveLength(0);
	});

	it("removes the anchor even when the browser refuses the click", () => {
		const refused = new DOMException("blocked", "SecurityError");
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
			throw refused;
		});

		expect(() => startBackendDownload("/api/logs/export?ticket=ab12")).toThrow(
			refused,
		);
		expect(document.querySelectorAll("a")).toHaveLength(0);
	});
});

const NOTE =
	"设备已知的密钥信息和常见标识符会被移除，但文件仍可能包含个人数据。分享前请先检查。";
const HINT =
	"给协助者的单个文件：版本、事件、近期日志和设置，已移除已知的密钥信息。";

function boundaries(chunks: string[]): number[] {
	const at: number[] = [];
	let offset = 0;
	for (const chunk of chunks.slice(0, -1)) {
		offset += chunk.length;
		at.push(offset);
	}
	return at;
}

function splitsInside(text: string, chunks: string[], word: string): boolean {
	const start = text.indexOf(word);
	expect(start).toBeGreaterThanOrEqual(0);
	return boundaries(chunks).some((b) => b > start && b < start + word.length);
}

describe("chineseWordChunks — where fixed Chinese copy may wrap", () => {
	it.each(["en", "ja", "ko", "de", "ar"])("returns %s copy whole", (locale) => {
		expect(chineseWordChunks(NOTE, locale)).toEqual([NOTE]);
	});

	it.each(["zh", "zh-Hant"])(
		"cuts %s copy into several chunks that join back to exactly the copy",
		(locale) => {
			const chunks = chineseWordChunks(NOTE, locale);
			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.join("")).toBe(NOTE);
			expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
		},
	);

	it("never cuts inside a word, including ones the dictionary splits into single characters", () => {
		const note = chineseWordChunks(NOTE, "zh");
		for (const word of [
			"设备",
			"密钥",
			"标识符",
			"文件",
			"个人",
			"数据",
			"分享",
		]) {
			expect(splitsInside(NOTE, note, word)).toBe(false);
		}
		const hint = chineseWordChunks(HINT, "zh");
		for (const word of ["协助者", "单个", "事件", "日志", "密钥"]) {
			expect(splitsInside(HINT, hint, word)).toBe(false);
		}
	});

	it("never starts a chunk with punctuation or a one-character word", () => {
		for (const text of [NOTE, HINT]) {
			for (const chunk of chineseWordChunks(text, "zh").slice(1)) {
				expect(chunk[0]).not.toMatch(/[，。、：；！？…]/);
				expect(chunk.length).toBeGreaterThan(1);
			}
		}
	});

	it("keeps Latin words and spaces as they are", () => {
		const text = "CeraLive 日志文件";
		const chunks = chineseWordChunks(text, "zh");
		expect(chunks.join("")).toBe(text);
		expect(splitsInside(text, chunks, "CeraLive")).toBe(false);
	});

	it("returns the copy whole when the browser has no word segmenter", () => {
		vi.stubGlobal(
			"Intl",
			Object.assign(Object.create(Intl), { Segmenter: undefined }),
		);
		expect(chineseWordChunks(NOTE, "zh")).toEqual([NOTE]);
	});

	it("returns the copy whole when the segmenter throws", () => {
		const built = vi.fn(() => {
			throw new RangeError("Unsupported locale");
		});
		vi.stubGlobal(
			"Intl",
			Object.assign(Object.create(Intl), {
				Segmenter: class {
					constructor() {
						built();
					}
				},
			}),
		);
		expect(chineseWordChunks(NOTE, "zh")).toEqual([NOTE]);
		expect(built).toHaveBeenCalledOnce();
	});

	function segmenterGiving(
		segments: Array<{ segment: string; isWordLike?: boolean }>,
	) {
		const segment = vi.fn(() => segments);
		vi.stubGlobal(
			"Intl",
			Object.assign(Object.create(Intl), {
				Segmenter: class {
					segment = segment;
				},
			}),
		);
		return segment;
	}

	it("does not break between segments the segmenter does not mark as words", () => {
		const segment = segmenterGiving([{ segment: "数据" }, { segment: "分享" }]);
		expect(chineseWordChunks("数据分享", "zh")).toEqual(["数据分享"]);
		expect(segment).toHaveBeenCalledOnce();
	});

	it("never starts a chunk with a run of punctuation such as a doubled dash", () => {
		const segment = segmenterGiving([
			{ segment: "数据", isWordLike: true },
			{ segment: "——", isWordLike: false },
			{ segment: "分享", isWordLike: true },
		]);
		expect(chineseWordChunks("数据——分享", "zh")).toEqual(["数据——分享"]);
		expect(segment).toHaveBeenCalledOnce();
	});

	it("returns the copy whole rather than drop or reorder it", () => {
		const segment = segmenterGiving([
			{ segment: "分享", isWordLike: true },
			{ segment: "数据", isWordLike: true },
		]);
		expect(chineseWordChunks("数据分享", "zh")).toEqual(["数据分享"]);
		expect(segment).toHaveBeenCalledOnce();
	});
});

const TOKEN = "0123456789abcdef".repeat(4);

describe("ticketReply — only the path the device minted for this flow", () => {
	it.each(["export", "bundle"] as const)(
		"accepts the backend's own %s ticket",
		(kind) => {
			const reply = {
				ok: true,
				url: `/api/logs/${kind}?ticket=${TOKEN}`,
				expiresAt: 60_000,
			};
			expect(ticketReply(reply, kind)).toStrictEqual(reply);
		},
	);

	it("passes a refusal through unchanged", () => {
		expect(ticketReply({ ok: false, error: "BUSY" }, "export")).toStrictEqual({
			ok: false,
			error: "BUSY",
		});
	});

	const HOSTILE: Array<[string, (kind: string, other: string) => string]> = [
		["another authority", () => "@example.invalid/support?ticket=controlled"],
		[
			"an absolute URL",
			(k) => `https://example.invalid/api/logs/${k}?ticket=${TOKEN}`,
		],
		[
			"a protocol-relative URL",
			(k) => `//example.invalid/api/logs/${k}?ticket=${TOKEN}`,
		],
		["another path", () => `/api/logs/other?ticket=${TOKEN}`],
		[
			"the other flow's path",
			(_k, other) => `/api/logs/${other}?ticket=${TOKEN}`,
		],
		[
			"a path without its leading slash",
			(k) => `api/logs/${k}?ticket=${TOKEN}`,
		],
		[
			"an extra query parameter",
			(k) => `/api/logs/${k}?ticket=${TOKEN}&next=x`,
		],
		["a fragment", (k) => `/api/logs/${k}?ticket=${TOKEN}#x`],
		[
			"an uppercase token",
			(k) => `/api/logs/${k}?ticket=${TOKEN.toUpperCase()}`,
		],
		["a short token", (k) => `/api/logs/${k}?ticket=${TOKEN.slice(1)}`],
		["a long token", (k) => `/api/logs/${k}?ticket=${TOKEN}0`],
		["a trailing newline", (k) => `/api/logs/${k}?ticket=${TOKEN}\n`],
	];

	it.each(
		(["export", "bundle"] as const).flatMap((kind) =>
			HOSTILE.map(
				([name, url]) =>
					[
						kind,
						name,
						url(kind, kind === "export" ? "bundle" : "export"),
					] as const,
			),
		),
	)("refuses a %s ticket with %s", (kind, _name, url) => {
		expect(() =>
			ticketReply({ ok: true, url, expiresAt: 60_000 }, kind),
		).toThrow(`Unexpected ${kind} ticket path`);
	});

	it("refuses a reply that does not match the wire schema", () => {
		expect(() => ticketReply(null, "export")).toThrow();
	});
});

describe("bundleManifestReply — a preview that can be shown as it is", () => {
	it("accepts a manifest naming each section once", () => {
		expect(bundleManifestReply(bundleManifest(7))).toStrictEqual(
			bundleManifest(7),
		);
	});

	it("refuses a manifest naming a section twice rather than merge its counts", () => {
		const repeated = {
			...bundleManifest(0),
			sections: [
				{ id: "versions", entries: 1, redactions: 0 },
				{ id: "versions", entries: 2, redactions: 0 },
			],
		};
		expect(() => bundleManifestReply(repeated)).toThrow(
			"Bundle manifest names a section twice",
		);
	});

	it("refuses a manifest that does not match the wire schema", () => {
		expect(() => bundleManifestReply({ sections: [] })).toThrow();
	});
});
