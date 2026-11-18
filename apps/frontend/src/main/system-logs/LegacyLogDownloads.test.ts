// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en, zh } from "../../tests/helpers/catalog";

import LegacyLogDownloads from "./LegacyLogDownloads.svelte";
import { LogDownloads } from "./log-downloads.svelte";

const getDeviceLog = vi.hoisted(() => vi.fn());
const getSystemLog = vi.hoisted(() => vi.fn());
vi.mock("$lib/helpers/SystemHelper", () => ({ getDeviceLog, getSystemLog }));

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
} {
	let resolve: () => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	getDeviceLog.mockReset();
	getSystemLog.mockReset();
});

afterEach(() => {
	cleanup();
	setLocale("en");
	vi.restoreAllMocks();
});

const mount = () =>
	render(LegacyLogDownloads, { props: { downloads: new LogDownloads() } });

const button = (kind: "device" | "system") =>
	screen.getByTestId(`log-download-${kind}`) as HTMLButtonElement;

describe("LegacyLogDownloads — the two shipped rows", () => {
	it.each([
		["device", en.advanced.ceraliveLog, en.advanced.ceraliveLogTooltip],
		["system", en.advanced.systemLog, en.advanced.systemLogTooltip],
	] as const)(
		"renders the %s row with its title, description and Download",
		(kind, title, desc) => {
			mount();

			const row = screen.getByTestId(`log-row-${kind}`);
			expect(within(row).getByText(title).className).toContain("font-semibold");
			expect(within(row).getByText(desc).className).toContain(
				"text-muted-foreground",
			);
			expect(button(kind).textContent?.trim()).toBe(en.advanced.download);
			expect(button(kind).disabled).toBe(false);
			expect(screen.queryByTestId("log-download-error")).toBeNull();
			expect(row.className).toContain("rounded-lg");
			const tile = row.querySelector("span");
			expect(tile?.className).toContain("bg-secondary");
			expect(tile?.querySelector("svg")).not.toBeNull();
			expect(button(kind).querySelector("svg")).not.toBeNull();
		},
	);

	it("lists the CeraLive log before the system log", () => {
		mount();
		const rows = screen
			.getAllByTestId(/^log-row-/)
			.map((node) => node.dataset.testid);
		expect(rows).toEqual(["log-row-device", "log-row-system"]);
	});
});

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("LegacyLogDownloads — the shipped anatomy", () => {
	it("keeps each row's tile, wrapping text and small outline Download button", async () => {
		const pending = deferred();
		getDeviceLog.mockReturnValue(pending.promise);
		mount();

		// Japanese breaks at phrases, Korean only at spaces, Chinese only between the
		// words its copy marks with <wbr> (C5 at 320/375 px).
		expect(tokens(screen.getByTestId("log-row-device").parentElement)).toEqual([
			"space-y-3",
			"[word-break:auto-phrase]",
			"[&:lang(ko)]:break-keep",
			"[&:lang(zh)]:break-keep",
			"wrap-break-word",
			"text-pretty",
		]);
		for (const kind of ["device", "system"] as const) {
			const row = screen.getByTestId(`log-row-${kind}`);
			expect(tokens(row)).toEqual([
				"flex",
				"flex-wrap",
				"items-center",
				"gap-3",
				"rounded-lg",
				"border",
				"p-3",
			]);
			const [tile, text] = [...row.children];
			expect(tokens(tile)).toEqual([
				"bg-secondary",
				"text-foreground",
				"grid",
				"size-10",
				"shrink-0",
				"place-items-center",
				"rounded-lg",
			]);
			expect(tokens(tile?.querySelector("svg"))).toContain("size-5");
			// Long copy (German, Hindi) wraps instead of truncating; below a 10rem text
			// column the button drops to its own line at the inline end.
			expect(tokens(text)).toEqual(["min-w-0", "grow", "basis-40"]);
			expect(tokens(text?.children[0])).toEqual(["text-sm", "font-semibold"]);
			expect(tokens(text?.children[1])).toEqual([
				"text-muted-foreground",
				"text-xs",
			]);
			expect(tokens(button(kind))).toEqual(
				expect.arrayContaining([
					"ms-auto",
					"shrink-0",
					"gap-1.5",
					"h-7",
					"border-border",
				]),
			);
		}
		expect(tokens(button("system").querySelector("svg"))).toContain("size-4");

		await fireEvent.click(button("device"));
		expect(tokens(button("device").querySelector("svg"))).toEqual(
			expect.arrayContaining([
				"size-4",
				"animate-spin",
				"motion-reduce:animate-none",
			]),
		);
		pending.resolve();
		await expect.poll(() => button("device").disabled).toBe(false);
	});

	it("lets Chinese descriptions and the failure line wrap only between words", async () => {
		getDeviceLog.mockRejectedValue(new Error("refused"));
		mount();
		setLocale("zh");
		await tick();
		await fireEvent.click(button("device"));
		const wraps = (text: string) =>
			screen.getByText(text).querySelectorAll("wbr").length;
		await expect
			.poll(() => screen.queryByTestId("log-download-error"))
			.not.toBeNull();
		for (const text of [
			zh.advanced.ceraliveLogTooltip,
			zh.advanced.systemLogTooltip,
			zh.advanced.downloadFailed,
		]) {
			expect(wraps(text)).toBeGreaterThan(0);
		}
	});

	it("keeps the retry band's icon, text and small outline Retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		getDeviceLog.mockRejectedValueOnce(new Error("network down"));
		mount();

		await fireEvent.click(button("device"));
		const band = await screen.findByTestId("log-download-error");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"flex",
			"flex-col",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
			"sm:flex-row",
			"sm:items-center",
		]);
		expect(tokens(band.querySelector(":scope > svg"))).toEqual(
			expect.arrayContaining(["text-status-warning", "size-4", "shrink-0"]),
		);
		expect(tokens(within(band).getByText(en.advanced.downloadFailed))).toEqual([
			"text-status-warning",
			"min-w-0",
			"flex-1",
			"text-xs",
		]);
		const retry = screen.getByTestId("log-download-retry");
		expect(tokens(retry)).toEqual(
			expect.arrayContaining(["shrink-0", "gap-1.5", "h-7", "border-border"]),
		);
		expect(tokens(retry.querySelector("svg"))).toContain("size-4");
	});
});

describe("LegacyLogDownloads — one download at a time", () => {
	it.each([
		["device", "system", getDeviceLog, getSystemLog],
		["system", "device", getSystemLog, getDeviceLog],
	] as const)(
		"requests only the %s log and locks both buttons while it runs",
		async (kind, other, own, foreign) => {
			const pending = deferred();
			own.mockReturnValue(pending.promise);
			mount();

			await fireEvent.click(button(kind));

			expect(own).toHaveBeenCalledTimes(1);
			expect(foreign).toHaveBeenCalledTimes(0);
			expect(button(kind).textContent?.trim()).toBe(en.advanced.downloading);
			expect(button(other).textContent?.trim()).toBe(en.advanced.download);
			expect(button(kind).disabled).toBe(true);
			expect(button(other).disabled).toBe(true);

			await fireEvent.click(button(other));
			expect(foreign).toHaveBeenCalledTimes(0);

			pending.resolve();
			await expect.poll(() => button(kind).disabled).toBe(false);
			expect(button(other).disabled).toBe(false);
			expect(button(kind).textContent?.trim()).toBe(en.advanced.download);
			expect(screen.queryByTestId("log-download-error")).toBeNull();
		},
	);
});

describe("LegacyLogDownloads — inline recovery", () => {
	it.each([
		["device", getDeviceLog, getSystemLog],
		["system", getSystemLog, getDeviceLog],
	] as const)(
		"shows the amber band after a failed %s download and retries that same log",
		async (kind, own, foreign) => {
			const failure = new Error("network down");
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			own.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
			mount();

			await fireEvent.click(button(kind));

			const band = await screen.findByTestId("log-download-error");
			expect(band.getAttribute("role")).toBe("alert");
			expect(band.className).toContain("border-status-warning/30");
			expect(band.className).toContain("bg-status-warning/10");
			expect(
				within(band).getByText(en.advanced.downloadFailed).className,
			).toContain("text-xs");
			expect(band.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
				"true",
			);
			expect(error).toHaveBeenCalledExactlyOnceWith(
				`Failed to request ${kind} log:`,
				failure,
			);

			const retry = screen.getByTestId(
				"log-download-retry",
			) as HTMLButtonElement;
			expect(retry.textContent?.trim()).toBe(en.advanced.retryDownload);
			expect(retry.disabled).toBe(false);
			await fireEvent.click(retry);

			expect(own).toHaveBeenCalledTimes(2);
			expect(foreign).toHaveBeenCalledTimes(0);
			await expect
				.poll(() => screen.queryByTestId("log-download-error"))
				.toBeNull();
		},
	);

	it("clears the band when a new download starts and locks Retry while it runs", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = deferred();
		getDeviceLog
			.mockRejectedValueOnce(new Error("network down"))
			.mockReturnValueOnce(pending.promise);
		mount();

		await fireEvent.click(button("device"));
		const retry = (await screen.findByTestId(
			"log-download-retry",
		)) as HTMLButtonElement;
		await fireEvent.click(retry);

		expect(screen.queryByTestId("log-download-error")).toBeNull();
		expect(getDeviceLog).toHaveBeenCalledTimes(2);
		pending.resolve();
		await expect.poll(() => button("device").disabled).toBe(false);
	});

	it("clears the band when the other log's download starts", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = deferred();
		getDeviceLog.mockRejectedValueOnce(new Error("network down"));
		getSystemLog.mockReturnValueOnce(pending.promise);
		mount();

		await fireEvent.click(button("device"));
		await screen.findByTestId("log-download-error");
		await fireEvent.click(button("system"));

		expect(screen.queryByTestId("log-download-error")).toBeNull();
		pending.resolve();
		await expect.poll(() => button("system").disabled).toBe(false);
	});
});
