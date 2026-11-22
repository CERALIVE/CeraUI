import type {
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcError } from "$lib/rpc/rpc-error";

import {
	handleLogBundleRequest,
	createBundle as issueBundle,
} from "../../../../backend/src/modules/device-logs/bundle";
import {
	abortLogExports,
	handleLogExportRequest,
	createExport as issueExport,
} from "../../../../backend/src/modules/device-logs/export";
import {
	BUNDLE_TICKET,
	EXPORT_TICKET,
	bundleManifest as manifest,
	EXPORT_TICKET as TICKET,
} from "./__fixtures__/sharing";

import { notifyHistoryChanged, onHistoryChanged } from "./history-bus";
import {
	exportInput,
	RAW_OPENING_QUERY,
	startBackendDownload,
} from "./sharing";
import { SharingFlow } from "./sharing-flow.svelte";

// Use real ticket admission and redemption, without host journal or bundle data.
vi.mock("../../../../backend/src/modules/device-logs/bundle-body", () => ({
	BUNDLE_TIME_MS: 60_000,
	buildBundle: async () => ({
		manifest: manifest(3),
		chunks: [],
		filename: "support.ndjson.gz",
	}),
}));
vi.mock("../../../../backend/src/modules/device-logs/export-body", () => ({
	EXPORT_TIME_MS: 120_000,
	exportChunks: function* () {
		yield new TextEncoder().encode("# complete: 0 entries\n");
	},
}));

const busyPreview = () =>
	new RpcError({ message: "BUSY", code: "INTERNAL_ERROR" });
const failedPreview = () =>
	new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" });

const flows: SharingFlow[] = [];

afterEach(() => {
	for (const flow of flows.splice(0)) flow.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function setup(current: () => boolean = () => true) {
	const createExport =
		vi.fn<(input: LogExportInput) => Promise<LogExportOutput>>();
	const previewBundle = vi.fn<() => Promise<LogBundleManifest>>();
	const createBundle = vi.fn<() => Promise<LogExportOutput>>();
	const download = vi.fn<(path: string) => void>();
	const flow = new SharingFlow({
		current,
		logs: { createExport, previewBundle, createBundle },
		download,
	});
	flows.push(flow);
	return { flow, createExport, previewBundle, createBundle, download };
}

it.each(["export", "bundle"] as const)(
	"starts no %s download for a ticket answered once the view's open has ended",
	async (kind) => {
		let open = true;
		const { flow, createExport, previewBundle, createBundle, download } = setup(
			() => open,
		);
		const held = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(held.promise);
		createBundle.mockReturnValue(held.promise);
		previewBundle.mockResolvedValue(manifest(3));
		let press: Promise<void>;
		if (kind === "export") {
			flow.openExport();
			press = flow.confirmExport();
		} else {
			await flow.openBundle();
			press = flow.downloadBundle();
		}

		open = false;
		held.resolve(kind === "export" ? EXPORT_TICKET : BUNDLE_TICKET);
		await press;

		expect(download).not.toHaveBeenCalled();
	},
);

it.each(["export", "bundle"] as const)(
	"starts a new %s download on the second press after a synchronous browser refusal",
	async (kind) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const conn = {};
		const requests: Promise<Response>[] = [];
		const issued: string[] = [];
		const create = async (call: Promise<LogExportOutput>) => {
			const reply = await call;
			if (reply.ok) issued.push(reply.url);
			return reply;
		};
		const handle =
			kind === "export" ? handleLogExportRequest : handleLogBundleRequest;
		vi.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(function (this: HTMLAnchorElement) {
				requests.push(handle(new Request(this.href)));
			})
			.mockImplementationOnce(() => {
				throw new DOMException("blocked", "SecurityError");
			});
		const flow = new SharingFlow({
			current: () => true,
			logs: {
				createExport: (input) => create(issueExport(conn, input)),
				previewBundle: async () => manifest(3),
				createBundle: () => create(issueBundle(conn)),
			},
			download: startBackendDownload,
		});
		flows.push(flow);
		const press =
			kind === "export"
				? () => flow.confirmExport()
				: () => flow.downloadBundle();
		try {
			if (kind === "export") {
				flow.view = { ...RAW_OPENING_QUERY, boot: "all" };
				flow.openExport();
			} else await flow.openBundle();

			await press();
			expect(kind === "export" ? flow.exportProblem : flow.bundleProblem).toBe(
				"failed",
			);
			expect(issued).toHaveLength(1);
			expect(requests).toHaveLength(0);

			await press();
			expect(kind === "export" ? flow.exportStep : flow.bundleStep).toBe(
				"closed",
			);
			expect(issued).toHaveLength(2);
			expect(issued[1]).not.toBe(issued[0]);
			expect(requests).toHaveLength(1);
			expect((await requests[0])?.status).toBe(200);
		} finally {
			for (const pending of requests) await (await pending).body?.cancel();
			await abortLogExports();
		}
	},
);

// A step the flow reaches behind its own awaits: bounded in microtask turns, never timed.
async function until(reached: () => boolean): Promise<void> {
	for (let turn = 0; turn < 100; turn++) {
		if (reached()) return;
		await Promise.resolve();
	}
	throw new Error("the flow did not settle");
}

describe("SharingFlow: Export this view", () => {
	it("starts closed on the Raw logs tab's opening view", () => {
		const { flow } = setup();
		expect(flow.exportStep).toBe("closed");
		expect(flow.exportProblem).toBeNull();
		expect(flow.view).toBe(RAW_OPENING_QUERY);
	});

	it("asks first: opening creates nothing", () => {
		const { flow, createExport } = setup();
		flow.openExport();
		expect(flow.exportStep).toBe("confirm");
		expect(createExport).not.toHaveBeenCalled();
	});

	it("exports the view the Raw logs tab shows and hands the ticket to the browser", async () => {
		const { flow, createExport, download } = setup();
		const view: LogQueryInput = {
			sources: ["engine"],
			levels: ["error"],
			text: "srt",
			boot: "all",
			since: 5_000,
			direction: "older",
			limit: 100,
		};
		flow.view = view;
		createExport.mockResolvedValue(TICKET);
		flow.openExport();

		await flow.confirmExport();

		expect(createExport).toHaveBeenCalledExactlyOnceWith(exportInput(view));
		expect(download).toHaveBeenCalledExactlyOnceWith(TICKET.url);
		expect(flow.exportStep).toBe("closed");
		expect(flow.exportProblem).toBeNull();
	});

	it("shows the request in flight and never stacks a second one", async () => {
		const { flow, createExport, download } = setup();
		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(reply.promise);
		flow.openExport();

		const first = flow.confirmExport();
		expect(flow.exportStep).toBe("creating");
		const second = flow.confirmExport();
		flow.openExport();
		expect(flow.exportStep).toBe("creating");
		expect(createExport).toHaveBeenCalledTimes(1);
		reply.resolve(TICKET);
		await Promise.all([first, second]);

		expect(createExport).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("does nothing on Download export when no confirmation is open", async () => {
		const { flow, createExport } = setup();
		await flow.confirmExport();
		expect(createExport).not.toHaveBeenCalled();
		expect(flow.exportStep).toBe("closed");
	});

	it("keeps the confirmation open on BUSY, and Download export asks again", async () => {
		const { flow, createExport, download } = setup();
		createExport.mockResolvedValueOnce({ ok: false, error: "BUSY" });
		flow.openExport();

		await flow.confirmExport();
		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBe("busy");
		expect(download).not.toHaveBeenCalled();

		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValueOnce(reply.promise);
		const retry = flow.confirmExport();
		expect(flow.exportProblem).toBeNull();
		reply.resolve(TICKET);
		await retry;
		expect(createExport).toHaveBeenCalledTimes(2);
		expect(download).toHaveBeenCalledExactlyOnceWith(TICKET.url);
	});

	it("states any other refusal as a failure without logging it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, createExport } = setup();
		createExport.mockResolvedValue({ ok: false, error: "BOOT_UNAVAILABLE" });
		flow.openExport();

		await flow.confirmExport();

		expect(flow.exportProblem).toBe("failed");
		expect(flow.exportStep).toBe("confirm");
		expect(error).not.toHaveBeenCalled();
	});

	it.each([
		["rejects", () => Promise.reject(new Error("Request timeout"))],
		[
			"throws",
			() => {
				throw new Error("socket gone");
			},
		],
	])("contains a call that %s as a logged failure", async (_name, call) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, createExport, download } = setup();
		createExport.mockImplementation(call);
		flow.openExport();

		await flow.confirmExport();

		expect(flow.exportProblem).toBe("failed");
		expect(flow.exportStep).toBe("confirm");
		expect(download).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toBe("System Logs sharing failed:");
	});

	it.each([
		["no reply", null],
		["a ticket without its url", { ok: true }],
		[
			"a ticket whose ok is not true",
			{ ok: "yes", url: "/api/logs/export?ticket=x" },
		],
		["a refusal the device cannot send", { ok: false, error: "NOT_A_CODE" }],
	] as const)(
		"states %s as a logged failure and keeps the confirmation",
		async (_name, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const { flow, createExport, download } = setup();
			createExport.mockResolvedValue(reply as unknown as LogExportOutput);
			flow.openExport();

			await expect(flow.confirmExport()).resolves.toBeUndefined();

			expect(flow.exportStep).toBe("confirm");
			expect(flow.exportProblem).toBe("failed");
			expect(download).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
			expect(error.mock.calls[0]?.[0]).toBe("System Logs sharing failed:");
		},
	);

	it("states a download the browser refuses as a logged failure, and Download export asks again", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, createExport, download } = setup();
		createExport.mockResolvedValue(TICKET);
		const refused = new DOMException("blocked", "SecurityError");
		download.mockImplementationOnce(() => {
			throw refused;
		});
		flow.openExport();

		await expect(flow.confirmExport()).resolves.toBeUndefined();
		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBe("failed");
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs sharing failed:",
			refused,
		);

		await flow.confirmExport();
		expect(createExport).toHaveBeenCalledTimes(2);
		expect(download).toHaveBeenNthCalledWith(2, TICKET.url);
		expect(flow.exportStep).toBe("closed");
		expect(flow.exportProblem).toBeNull();
	});

	it("refuses a ticket that points off the backend origin as a logged failure, and downloads nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, createExport, download } = setup();
		createExport.mockResolvedValue({
			ok: true,
			url: "@example.invalid/support?ticket=controlled",
			expiresAt: 60000,
		});
		flow.openExport();

		await expect(flow.confirmExport()).resolves.toBeUndefined();

		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBe("failed");
		expect(download).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("discards a ticket that arrives after Cancel, and leaves no timer", async () => {
		vi.useFakeTimers();
		const { flow, createExport, download } = setup();
		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(reply.promise);
		flow.openExport();
		const request = flow.confirmExport();

		flow.closeExport();
		expect(flow.exportStep).toBe("closed");
		reply.resolve(TICKET);
		await request;

		expect(download).not.toHaveBeenCalled();
		expect(flow.exportStep).toBe("closed");
		expect(flow.exportProblem).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards a refusal that arrives after Cancel", async () => {
		const { flow, createExport } = setup();
		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(reply.promise);
		flow.openExport();
		const request = flow.confirmExport();
		flow.closeExport();

		reply.resolve({ ok: false, error: "BUSY" });
		await request;

		expect(flow.exportProblem).toBeNull();
		expect(flow.exportStep).toBe("closed");
	});

	it("starts clean when reopened after a problem", async () => {
		const { flow, createExport } = setup();
		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		flow.openExport();
		await flow.confirmExport();

		flow.closeExport();
		flow.openExport();

		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBeNull();
	});

	it("still downloads when asked again after a Cancel", async () => {
		const { flow, createExport, download } = setup();
		createExport.mockReturnValueOnce(new Promise<never>(() => {}));
		flow.openExport();
		void flow.confirmExport();
		flow.closeExport();
		createExport.mockResolvedValueOnce(TICKET);
		flow.openExport();

		await flow.confirmExport();

		expect(download).toHaveBeenCalledExactlyOnceWith(TICKET.url);
		expect(flow.exportStep).toBe("closed");
	});

	it("ignores a second open while the confirmation shows a problem", async () => {
		const { flow, createExport } = setup();
		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		flow.openExport();
		await flow.confirmExport();

		flow.openExport();

		expect(flow.exportProblem).toBe("busy");
	});
});

describe("SharingFlow: support bundle", () => {
	it("starts closed with no manifest", () => {
		const { flow } = setup();
		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(flow.bundleProblem).toBeNull();
	});

	it("opens on a preview, and Download does nothing until the manifest arrives", async () => {
		const { flow, previewBundle, createBundle } = setup();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValue(reply.promise);

		const opened = flow.openBundle();
		expect(flow.bundleStep).toBe("previewing");
		expect(flow.manifest).toBeNull();
		await flow.downloadBundle();
		expect(createBundle).not.toHaveBeenCalled();

		reply.resolve(manifest(120));
		await opened;
		expect(flow.bundleStep).toBe("preview");
		expect(flow.manifest).toStrictEqual(manifest(120));
		expect(flow.bundleProblem).toBeNull();
		expect(previewBundle).toHaveBeenCalledTimes(1);
	});

	it("never stacks a second preview while one runs or is shown", async () => {
		const { flow, previewBundle } = setup();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValue(reply.promise);

		const opened = flow.openBundle();
		const again = flow.openBundle();
		const retried = flow.retryPreview();
		expect(previewBundle).toHaveBeenCalledTimes(1);
		reply.resolve(manifest(1));
		await Promise.all([opened, again, retried]);
		await flow.openBundle();
		await flow.retryPreview();

		expect(previewBundle).toHaveBeenCalledTimes(1);
		expect(flow.bundleStep).toBe("preview");
	});

	it("tells a busy preview apart from a failed one, and Retry previews again", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle } = setup();
		previewBundle.mockRejectedValueOnce(busyPreview());

		await flow.openBundle();
		expect(flow.bundleStep).toBe("preview");
		expect(flow.manifest).toBeNull();
		expect(flow.bundleProblem).toBe("busy");
		expect(error).not.toHaveBeenCalled();

		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValueOnce(reply.promise);
		const retried = flow.retryPreview();
		expect(flow.bundleStep).toBe("previewing");
		expect(flow.bundleProblem).toBeNull();
		reply.reject(failedPreview());
		await retried;

		expect(flow.bundleProblem).toBe("failed");
		expect(flow.manifest).toBeNull();
		expect(previewBundle).toHaveBeenCalledTimes(2);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toBe("System Logs sharing failed:");
	});

	it.each([
		["no manifest", null],
		["a manifest without its versions and boots", { sections: [] }],
		[
			"a section the bundle does not hold",
			{
				...manifest(3),
				sections: [{ id: "secrets", entries: 1, redactions: 0 }],
			},
		],
	] as const)(
		"states a preview answering %s as a logged failure that Download cannot use",
		async (_name, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const { flow, previewBundle, createBundle } = setup();
			previewBundle
				.mockResolvedValueOnce(reply as unknown as LogBundleManifest)
				.mockResolvedValueOnce(manifest(4));

			await flow.openBundle();
			expect(flow.bundleStep).toBe("preview");
			expect(flow.manifest).toBeNull();
			expect(flow.bundleProblem).toBe("failed");
			expect(error).toHaveBeenCalledTimes(1);
			await flow.downloadBundle();
			expect(createBundle).not.toHaveBeenCalled();

			await flow.retryPreview();
			expect(flow.manifest).toStrictEqual(manifest(4));
			expect(flow.bundleProblem).toBeNull();
		},
	);

	it("does not retry a preview when the flow is closed", async () => {
		const { flow, previewBundle } = setup();
		await flow.retryPreview();
		expect(previewBundle).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("closed");
	});

	it("creates the bundle from the shown preview and hands its ticket to the browser", async () => {
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		const reply = Promise.withResolvers<LogExportOutput>();
		createBundle.mockReturnValue(reply.promise);
		await flow.openBundle();

		const created = flow.downloadBundle();
		expect(flow.bundleStep).toBe("creating");
		const again = flow.downloadBundle();
		expect(createBundle).toHaveBeenCalledTimes(1);
		reply.resolve(BUNDLE_TICKET);
		await Promise.all([created, again]);

		expect(createBundle).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledExactlyOnceWith(BUNDLE_TICKET.url);
		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(flow.bundleProblem).toBeNull();
	});

	it("keeps the manifest on a refused creation and lets Download ask again", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		createBundle
			.mockResolvedValueOnce({ ok: false, error: "BUSY" })
			.mockRejectedValueOnce(new Error("Request timeout"))
			.mockResolvedValueOnce(BUNDLE_TICKET);
		await flow.openBundle();

		await flow.downloadBundle();
		expect(flow.bundleStep).toBe("preview");
		expect(flow.bundleProblem).toBe("busy");
		expect(flow.manifest).toStrictEqual(manifest(3));

		await flow.downloadBundle();
		expect(flow.bundleProblem).toBe("failed");
		expect(error).toHaveBeenCalledTimes(1);

		const third = flow.downloadBundle();
		expect(flow.bundleProblem).toBeNull();
		await third;
		expect(download).toHaveBeenCalledExactlyOnceWith(BUNDLE_TICKET.url);
	});

	it("marks a preview the device refused to prepare, and only that one, as a refusal Export can replace", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle } = setup();
		previewBundle
			.mockRejectedValueOnce(failedPreview())
			.mockRejectedValueOnce(busyPreview())
			.mockRejectedValueOnce(new Error("Request timeout: logs.previewBundle"))
			.mockResolvedValueOnce(manifest(2));

		await flow.openBundle();
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.bundleRefused).toBe(true);

		await flow.retryPreview();
		expect(flow.bundleProblem).toBe("busy");
		expect(flow.bundleRefused).toBe(false);

		await flow.retryPreview();
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.bundleRefused).toBe(false);

		await flow.retryPreview();
		expect(flow.manifest).toStrictEqual(manifest(2));
		expect(flow.bundleRefused).toBe(false);
	});

	it("keeps the device's sanitized stage of a refused preview until the next attempt or close", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle } = setup();
		previewBundle
			.mockRejectedValueOnce(
				new RpcError({
					message: "READ_FAILED",
					code: "INTERNAL_ERROR",
					stage: "collision",
				}),
			)
			.mockRejectedValueOnce(busyPreview())
			.mockRejectedValueOnce(failedPreview())
			.mockResolvedValueOnce(manifest(2));

		await flow.openBundle();
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.bundleFailure).toBe("collision");
		expect(flow.bundleRefused).toBe(true);

		await flow.retryPreview();
		expect(flow.bundleProblem).toBe("busy");
		expect(flow.bundleFailure).toBeNull();

		await flow.retryPreview();
		expect(flow.bundleFailure).toBe("internal");
		expect(flow.bundleRefused).toBe(true);

		await flow.retryPreview();
		expect(flow.manifest).toStrictEqual(manifest(2));
		expect(flow.bundleFailure).toBeNull();

		previewBundle.mockRejectedValueOnce(
			new RpcError({
				message: "READ_FAILED",
				code: "INTERNAL_ERROR",
				stage: "journal_read",
			}),
		);
		flow.closeBundle();
		await flow.openBundle();
		expect(flow.bundleFailure).toBe("journal_read");
		flow.closeBundle();
		expect(flow.bundleFailure).toBeNull();
	});

	it("marks a creation the device refused as READ_FAILED as a refusal Export can replace, not a call that failed here", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		createBundle
			.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" })
			.mockResolvedValueOnce({ ok: false, error: "BUSY" })
			.mockRejectedValueOnce(new Error("Request timeout"));
		await flow.openBundle();

		await flow.downloadBundle();
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.bundleRefused).toBe(true);

		await flow.downloadBundle();
		expect(flow.bundleRefused).toBe(false);

		await flow.downloadBundle();
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.bundleRefused).toBe(false);
	});

	it("leaves a refused bundle for the Export confirmation", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle } = setup();
		previewBundle.mockRejectedValueOnce(failedPreview());
		await flow.openBundle();

		flow.exportInstead();

		expect(flow.bundleStep).toBe("closed");
		expect(flow.bundleProblem).toBeNull();
		expect(flow.bundleRefused).toBe(false);
		expect(flow.exportStep).toBe("confirm");
	});

	it.each([
		["no reply", null],
		["a ticket without its url", { ok: true }],
	] as const)(
		"keeps the manifest when creation answers %s, as a logged failure",
		async (_name, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const { flow, previewBundle, createBundle, download } = setup();
			previewBundle.mockResolvedValue(manifest(3));
			createBundle.mockResolvedValue(reply as unknown as LogExportOutput);
			await flow.openBundle();

			await expect(flow.downloadBundle()).resolves.toBeUndefined();

			expect(flow.bundleStep).toBe("preview");
			expect(flow.bundleProblem).toBe("failed");
			expect(flow.manifest).toStrictEqual(manifest(3));
			expect(download).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps the manifest when the browser refuses the bundle download, and Download asks again", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		createBundle.mockResolvedValue(BUNDLE_TICKET);
		const refused = new DOMException("blocked", "SecurityError");
		download.mockImplementationOnce(() => {
			throw refused;
		});
		await flow.openBundle();

		await expect(flow.downloadBundle()).resolves.toBeUndefined();
		expect(flow.bundleStep).toBe("preview");
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.manifest).toStrictEqual(manifest(3));
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs sharing failed:",
			refused,
		);

		await flow.downloadBundle();
		expect(download).toHaveBeenNthCalledWith(2, BUNDLE_TICKET.url);
		expect(flow.bundleStep).toBe("closed");
	});

	it("refuses an export ticket handed to the bundle, keeping the manifest and downloading nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		createBundle.mockResolvedValue(TICKET);
		await flow.openBundle();

		await expect(flow.downloadBundle()).resolves.toBeUndefined();

		expect(flow.bundleStep).toBe("preview");
		expect(flow.bundleProblem).toBe("failed");
		expect(flow.manifest).toStrictEqual(manifest(3));
		expect(download).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("refuses a manifest naming a section twice before it can be shown, and Retry reads it again", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle } = setup();
		previewBundle
			.mockResolvedValueOnce({
				...manifest(0),
				sections: [
					{ id: "versions", entries: 1, redactions: 0 },
					{ id: "versions", entries: 2, redactions: 0 },
				],
			})
			.mockResolvedValueOnce(manifest(4));

		await flow.openBundle();
		expect(flow.bundleStep).toBe("preview");
		expect(flow.manifest).toBeNull();
		expect(flow.bundleProblem).toBe("failed");
		expect(error).toHaveBeenCalledTimes(1);
		await flow.downloadBundle();
		expect(createBundle).not.toHaveBeenCalled();

		await flow.retryPreview();
		expect(flow.manifest).toStrictEqual(manifest(4));
	});

	it("discards a preview that arrives after Cancel, and leaves no timer", async () => {
		vi.useFakeTimers();
		const { flow, previewBundle } = setup();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValue(reply.promise);
		const opened = flow.openBundle();

		flow.closeBundle();
		reply.resolve(manifest(5));
		await opened;

		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards a failed preview that arrives after Cancel", async () => {
		const { flow, previewBundle } = setup();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValue(reply.promise);
		const opened = flow.openBundle();

		flow.closeBundle();
		reply.reject(busyPreview());
		await opened;

		expect(flow.bundleStep).toBe("closed");
		expect(flow.bundleProblem).toBeNull();
	});

	it("discards a bundle ticket that arrives after Cancel", async () => {
		vi.useFakeTimers();
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		const reply = Promise.withResolvers<LogExportOutput>();
		createBundle.mockReturnValue(reply.promise);
		await flow.openBundle();
		const created = flow.downloadBundle();

		flow.closeBundle();
		reply.resolve(BUNDLE_TICKET);
		await created;

		expect(download).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never creates a bundle after a failed preview", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { flow, previewBundle, createBundle } = setup();
		previewBundle.mockRejectedValue(failedPreview());
		await flow.openBundle();

		await flow.downloadBundle();

		expect(createBundle).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("preview");
	});

	it("still downloads a bundle when asked again after a Cancel", async () => {
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(3));
		createBundle.mockReturnValueOnce(new Promise<never>(() => {}));
		await flow.openBundle();
		void flow.downloadBundle();
		expect(createBundle).toHaveBeenCalledTimes(1);
		flow.closeBundle();
		createBundle.mockResolvedValueOnce(BUNDLE_TICKET);
		await flow.openBundle();

		await flow.downloadBundle();

		expect(download).toHaveBeenCalledExactlyOnceWith(BUNDLE_TICKET.url);
	});

	it("reopens on a fresh preview after Cancel", async () => {
		const { flow, previewBundle } = setup();
		previewBundle.mockRejectedValueOnce(busyPreview());
		await flow.openBundle();
		flow.closeBundle();
		expect(flow.bundleProblem).toBeNull();

		previewBundle.mockResolvedValueOnce(manifest(8));
		await flow.openBundle();

		expect(previewBundle).toHaveBeenCalledTimes(2);
		expect(flow.manifest).toStrictEqual(manifest(8));
		expect(flow.bundleProblem).toBeNull();
	});
});

describe("SharingFlow: deleted history", () => {
	it("reads the preview again so a stale manifest is never offered", async () => {
		const { flow, previewBundle } = setup();
		previewBundle.mockResolvedValueOnce(manifest(500));
		await flow.openBundle();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValueOnce(reply.promise);

		notifyHistoryChanged();
		expect(flow.bundleStep).toBe("previewing");
		expect(flow.manifest).toBeNull();
		reply.resolve(manifest(4));
		await until(() => flow.bundleStep === "preview");

		expect(previewBundle).toHaveBeenCalledTimes(2);
		expect(flow.bundleStep).toBe("preview");
		expect(flow.manifest).toStrictEqual(manifest(4));
	});

	it("discards a preview in flight and reads a fresh one", async () => {
		const { flow, previewBundle } = setup();
		const stale = Promise.withResolvers<LogBundleManifest>();
		const fresh = Promise.withResolvers<LogBundleManifest>();
		previewBundle
			.mockReturnValueOnce(stale.promise)
			.mockReturnValueOnce(fresh.promise);
		const opened = flow.openBundle();

		notifyHistoryChanged();
		stale.resolve(manifest(500));
		await opened;
		expect(flow.manifest).toBeNull();
		fresh.resolve(manifest(4));
		await until(() => flow.bundleStep === "preview");

		expect(flow.manifest).toStrictEqual(manifest(4));
	});

	it("discards a bundle being created and previews again", async () => {
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValueOnce(manifest(500));
		const ticket = Promise.withResolvers<LogExportOutput>();
		createBundle.mockReturnValue(ticket.promise);
		await flow.openBundle();
		const created = flow.downloadBundle();
		const reply = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValueOnce(reply.promise);

		notifyHistoryChanged();
		ticket.resolve(BUNDLE_TICKET);
		await created;
		expect(download).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("previewing");
		reply.resolve(manifest(4));
		await until(() => flow.bundleStep === "preview");

		expect(flow.manifest).toStrictEqual(manifest(4));
	});

	it("reads nothing while the bundle is closed", () => {
		const { flow, previewBundle } = setup();
		notifyHistoryChanged();
		expect(previewBundle).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("closed");
	});

	it("interrupts an export being created: its ticket is discarded and the failure stated", async () => {
		const { flow, createExport, download } = setup();
		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(reply.promise);
		flow.openExport();
		const request = flow.confirmExport();

		notifyHistoryChanged();
		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBe("failed");
		reply.resolve(TICKET);
		await request;

		expect(download).not.toHaveBeenCalled();
		expect(flow.exportStep).toBe("confirm");
	});

	it("leaves a confirmation that is only waiting untouched", () => {
		const { flow } = setup();
		flow.openExport();
		notifyHistoryChanged();
		expect(flow.exportStep).toBe("confirm");
		expect(flow.exportProblem).toBeNull();
	});
});

describe("SharingFlow: dispose", () => {
	it("closes both flows, ignores late replies and stops listening for history", async () => {
		const { flow, createExport, previewBundle, download } = setup();
		const ticket = Promise.withResolvers<LogExportOutput>();
		const preview = Promise.withResolvers<LogBundleManifest>();
		createExport.mockReturnValue(ticket.promise);
		previewBundle.mockReturnValue(preview.promise);
		flow.openExport();
		const request = flow.confirmExport();
		const opened = flow.openBundle();

		flow.dispose();
		ticket.resolve(TICKET);
		preview.resolve(manifest(2));
		await Promise.all([request, opened]);
		notifyHistoryChanged();

		expect(flow.exportStep).toBe("closed");
		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(download).not.toHaveBeenCalled();
		expect(previewBundle).toHaveBeenCalledTimes(1);
	});

	it("can be disposed twice without touching another listener or asking the device", () => {
		const other = vi.fn();
		const stopOther = onHistoryChanged(other);
		const { flow, createExport, previewBundle, createBundle } = setup();
		flow.openExport();

		flow.dispose();
		flow.dispose();
		notifyHistoryChanged();
		stopOther();

		expect(other).toHaveBeenCalledTimes(1);
		expect(flow.exportStep).toBe("closed");
		expect(flow.bundleStep).toBe("closed");
		expect(createExport).not.toHaveBeenCalled();
		expect(previewBundle).not.toHaveBeenCalled();
		expect(createBundle).not.toHaveBeenCalled();
	});

	it("downloads nothing for a bundle ticket that lands after dispose", async () => {
		const { flow, previewBundle, createBundle, download } = setup();
		previewBundle.mockResolvedValue(manifest(2));
		const ticket = Promise.withResolvers<LogExportOutput>();
		createBundle.mockReturnValue(ticket.promise);
		await flow.openBundle();
		const created = flow.downloadBundle();

		flow.dispose();
		ticket.resolve(BUNDLE_TICKET);
		await created;

		expect(download).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
	});

	it("is no longer told about deleted history, whatever step it is left in", () => {
		const { flow, previewBundle } = setup();
		flow.dispose();
		flow.bundleStep = "preview";

		notifyHistoryChanged();

		expect(previewBundle).not.toHaveBeenCalled();
		expect(flow.bundleStep).toBe("preview");
	});
});

describe("SharingFlow: the export scope is fixed when the confirmation opens", () => {
	const opened = {
		...RAW_OPENING_QUERY,
		levels: ["error"],
		text: "needle",
	} as const;
	const later = {
		sources: ["kernel"],
		levels: ["debug"],
		boot: "all",
	} as const;

	it("states and sends the scope it opened with, whatever Raw publishes meanwhile", async () => {
		const { flow, createExport } = setup();
		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		const raw = flow.bindView();
		raw.publish(opened);

		flow.openExport();
		const stated = flow.exportScope;
		raw.publish(later, "moment");
		await flow.confirmExport();

		expect(flow.exportScope).toBe(stated);
		expect(stated).toEqual({ query: opened, span: "filters", bootStart: null });
		expect(createExport).toHaveBeenCalledExactlyOnceWith(exportInput(opened));
		flow.closeExport();
		expect(flow.exportScope).toBeNull();
	});

	it("follows the picker used after Raw's last view, and Raw again once it publishes", () => {
		const { createExport, previewBundle, createBundle, download } = setup();
		const picker = { boot: null, intent: 0 };
		const flow = new SharingFlow({
			current: () => true,
			logs: { createExport, previewBundle, createBundle },
			download,
			picker,
		});
		flows.push(flow);
		const scopeOnOpen = () => {
			flow.openExport();
			const scope = flow.exportScope?.query;
			flow.closeExport();
			return scope;
		};
		const raw = flow.bindView();

		expect(scopeOnOpen()).toEqual({ ...RAW_OPENING_QUERY, boot: "all" });
		raw.publish(opened);
		expect(scopeOnOpen()).toEqual(opened);
		picker.intent += 1;
		expect(scopeOnOpen()).toEqual({ ...opened, boot: "all" });
		raw.publish(later);
		expect(scopeOnOpen()).toEqual(later);
	});
});
