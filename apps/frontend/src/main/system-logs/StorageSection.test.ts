// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type { LogStorage } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onHistoryChanged } from "$lib/device-logs/history-bus";

import { de, en, es, zh } from "../../tests/helpers/catalog";

import { logStorage, MIB } from "./__fixtures__/log-storage";
import StorageSection from "./StorageSection.svelte";

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: vi.fn(),
		setRetention: vi.fn(),
		deleteOlderFiles: vi.fn(),
		deleteLegacyDebug: vi.fn(),
		clearAll: vi.fn(),
	},
	events: { clear: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));

const copy = en.systemLogs.storage;
const historyChanged = vi.fn();
let stopListening: () => void = () => {};

function fill(
	template: string,
	params: Record<string, string | number>,
): string {
	return template.replace(/\{(\w+)\}/g, (_, key: string) =>
		String(params[key]),
	);
}

function rpcCalls(): number {
	return [...Object.values(rpc.logs), rpc.events.clear].reduce(
		(sum, mock) => sum + mock.mock.calls.length,
		0,
	);
}

beforeEach(() => {
	for (const mock of [...Object.values(rpc.logs), rpc.events.clear])
		mock.mockReset();
	historyChanged.mockReset();
	stopListening = onHistoryChanged(historyChanged);
});

afterEach(() => {
	stopListening();
	cleanup();
	setLocale("en");
	vi.restoreAllMocks();
});

/** Long localized cleanup labels wrap inside their column instead of pushing it wider. */
const WRAPS = [
	"h-auto",
	"max-w-full",
	"whitespace-normal",
	"text-start",
	"py-1",
];
/** The small button size, now that WRAPS replaces its fixed h-7 height. */
const SMALL = "text-[0.8rem]";
/**
 * Japanese breaks between phrases, Korean only between words, a word too long
 * for its line still wraps, and no paragraph ends on a lone character.
 */
const LINE_BREAKS = [
	"[word-break:auto-phrase]",
	"[&:lang(ko)]:break-keep",
	"[&:lang(zh)]:break-keep",
	"wrap-break-word",
	"text-pretty",
];
/** Room for a long localized confirm label beside Cancel in the two Storage confirmations. */
const WIDE_CONFIRM = "data-[size=default]:sm:max-w-lg";
/** A long localized confirm or Cancel label wraps inside its own button in both Storage confirmations. */
const WRAPPING_CONFIRM_BUTTONS = [
	"[&_[data-slot=alert-dialog-footer]>button]:h-auto",
	"[&_[data-slot=alert-dialog-footer]>button]:min-h-[max(2.5rem,var(--touch-target-min))]",
	"[&_[data-slot=alert-dialog-footer]>button]:whitespace-normal",
	"[&_[data-slot=alert-dialog-footer]>button]:text-center",
];

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** A formatted date or size as Storage shows it: one unbreakable value. */
const whole = (value: string) => value.replaceAll(" ", "\u00a0");

const stamp = (ts: number, locale = "en") =>
	new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(ts);

function mount(storage: LogStorage = logStorage()) {
	return render(StorageSection, { props: { storage } });
}

const ageSelect = () =>
	screen.getByRole("combobox", { name: copy.keepForLabel });
const sizeSelect = () =>
	screen.getByRole("combobox", { name: copy.maxSizeLabel });

async function openOptions(trigger: HTMLElement): Promise<string[]> {
	await fireEvent.keyDown(trigger, { key: "ArrowDown" });
	const options = await screen.findAllByRole("option");
	return options.map((option) => option.textContent?.trim() ?? "");
}

async function choose(trigger: HTMLElement, name: string): Promise<void> {
	await fireEvent.keyDown(trigger, { key: "ArrowDown" });
	const option = await screen.findByRole("option", { name });
	await fireEvent.pointerUp(option);
	await fireEvent.click(option);
	flushSync();
}

async function confirmAction(trigger: string, confirm: string): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: trigger }));
	const dialog = await screen.findByRole("alertdialog");
	await fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

describe("StorageSection — survivor regressions", () => {
	it.each([
		[copy.keepForLabel, copy.keepForDevice],
		[copy.maxSizeLabel, copy.maxSizeDevice],
	])("offers only the unknown device limit in %s", async (label, device) => {
		mount(logStorage({ ceiling: null }));

		const choices = await openOptions(
			screen.getByRole("combobox", { name: label }),
		);
		expect(choices).toEqual([
			fill(device, { value: en.systemLogs.versions.notReported }),
		]);
	});

	it("formats a fractional device size ceiling in the active locale", () => {
		setLocale("de");
		mount(logStorage({ ceiling: { maxSizeMb: 1536, maxAgeDays: 30 } }));

		expect(
			screen
				.getByRole("combobox", { name: de.systemLogs.storage.maxSizeLabel })
				.textContent?.trim(),
		).toBe(fill(de.systemLogs.storage.maxSizeDevice, { value: "1,5\u00a0GB" }));
	});

	it("withdraws the previous error while a save retry is pending", async () => {
		let resolveRetry: (value: unknown) => void = () => {};
		rpc.logs.setRetention.mockResolvedValueOnce({
			ok: false,
			error: "READ_FAILED",
		});
		rpc.logs.setRetention.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRetry = resolve;
			}),
		);
		mount();

		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));
		await screen.findByTestId("storage-save-failed");
		await fireEvent.click(screen.getByTestId("storage-save-failed-retry"));

		expect(screen.queryByTestId("storage-save-failed")).toBeNull();
		expect(screen.getByTestId("storage-save").getAttribute("aria-busy")).toBe(
			"true",
		);
		resolveRetry({ ok: true, storage: logStorage() });
		await waitFor(() =>
			expect(
				screen.getByTestId("storage-save-status").textContent?.trim(),
			).toBe(copy.saved),
		);
	});
});

describe("StorageSection — usage readout", () => {
	it("states the space logs use against the device's limit", () => {
		mount();

		const usage = screen.getByTestId("storage-usage-text");
		expect(usage.textContent?.trim()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(usage.dataset.state).toBe("reported");
		const meter = screen.getByTestId("storage-usage-meter");
		expect(meter.getAttribute("aria-hidden")).toBe("true");
		expect((meter.firstElementChild as HTMLElement | null)?.style.width).toBe(
			"18.75%",
		);
	});

	it("draws a sliver for usage under 1 %, and an empty track only when nothing is used", () => {
		const fill = () =>
			screen.getByTestId("storage-usage-meter")
				.firstElementChild as HTMLElement;
		const small = mount(logStorage({ journalBytes: 16_000 }));
		expect(fill().classList.contains("min-w-1")).toBe(true);
		small.unmount();

		mount(logStorage({ journalBytes: 0 }));
		expect(fill().style.width).toBe("0%");
		expect(fill().classList.contains("min-w-1")).toBe(false);
	});

	it("measures against a saved size limit", () => {
		mount(
			logStorage({
				retention: { maxAgeDays: null, maxSizeMb: 64, detail: "debug" },
			}),
		);

		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "64\u00a0MB" }),
		);
		expect(
			(
				screen.getByTestId("storage-usage-meter")
					.firstElementChild as HTMLElement
			).style.width,
		).toBe("75%");
	});

	it("says usage is not reported, with no bar and no zero, when the device does not count it", () => {
		mount(logStorage({ journalBytes: null, journalDirBytes: null }));

		const usage = screen.getByTestId("storage-usage-text");
		expect(usage.textContent?.trim()).toBe(copy.notReported);
		expect(usage.textContent).not.toMatch(/0/);
		expect(usage.dataset.state).toBe("unknown");
		expect(screen.queryByTestId("storage-usage-meter")).toBeNull();
		expect(screen.queryByTestId("storage-on-disk")).toBeNull();
	});

	it("states usage without a limit or bar when the device limit is unknown", () => {
		mount(logStorage({ ceiling: null }));

		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.usedNoLimit, { used: "48\u00a0MB" }),
		);
		expect(screen.queryByTestId("storage-usage-meter")).toBeNull();
	});

	it("shows the on-disk total only when the journal directory holds more than the journal counts", () => {
		mount(logStorage({ journalDirBytes: 300 * MIB }));
		expect(screen.getByTestId("storage-on-disk").textContent?.trim()).toBe(
			fill(copy.onDisk, { total: "300\u00a0MB" }),
		);
		cleanup();

		mount(logStorage({ journalDirBytes: 48 * MIB }));
		expect(screen.queryByTestId("storage-on-disk")).toBeNull();
	});

	it("states the oldest entry, the event history size and when logs were last cleared", () => {
		const oldest = Date.UTC(2026, 10, 1, 8, 30);
		const cleared = Date.UTC(2026, 10, 14, 21, 5);
		mount(logStorage({ oldestEntryTs: oldest, lastClearedAt: cleared }));

		const date = (ts: number) =>
			new Intl.DateTimeFormat("en", {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(ts);
		const oldestLine = screen.getByTestId("storage-oldest");
		expect(oldestLine.textContent?.trim()).toBe(
			fill(copy.oldest, { date: whole(date(oldest)) }),
		);
		expect(oldestLine.dataset.state).toBe("reported");
		expect(screen.getByTestId("storage-events").textContent?.trim()).toBe(
			fill(copy.events, { size: "18\u00a0KB" }),
		);
		expect(screen.getByTestId("storage-last-cleared").textContent?.trim()).toBe(
			fill(copy.lastCleared, { time: whole(date(cleared)) }),
		);
	});

	it("says the oldest entry is not reported, and omits a never-run clear", () => {
		mount(logStorage({ oldestEntryTs: null, lastClearedAt: null }));

		const oldestLine = screen.getByTestId("storage-oldest");
		expect(oldestLine.textContent?.trim()).toBe(copy.oldestUnknown);
		expect(oldestLine.dataset.state).toBe("unknown");
		expect(screen.queryByTestId("storage-last-cleared")).toBeNull();
	});

	it("lists recent volume by source, largest first, labelled as a sample", () => {
		mount();

		const volume = screen.getByTestId("storage-volume");
		expect(within(volume).getByText(copy.volumeHeading)).toBeTruthy();
		expect(
			within(volume).getByText(fill(copy.volumeSample, { count: "3,312" })),
		).toBeTruthy();
		const table = within(volume).getByRole("table", {
			name: copy.volumeHeading,
		});
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent?.trim()),
		).toEqual([copy.volumeSource, copy.volumeEntries, copy.volumeSize]);
		const rows = within(table).getAllByTestId("storage-volume-row");
		expect(
			rows.map((row) =>
				[...row.children].map((cell) => cell.textContent?.trim()),
			),
		).toEqual([
			[en.systemLogs.source.app, "2,400", "293\u00a0KB"],
			[en.systemLogs.source.network, "900", "87.9\u00a0KB"],
			[en.systemLogs.source.other, "12", "9.8\u00a0KB"],
		]);
		expect(
			rows.map(
				(row) =>
					row.querySelector<HTMLElement>(
						'[data-testid="storage-volume-meter"] > span',
					)?.style.width,
			),
		).toEqual(["75%", "22.5%", "2.5%"]);
		for (const row of rows) {
			expect(within(row).getByRole("rowheader")).toBeTruthy();
		}
	});

	it("names every source the device reports", () => {
		const sources = [
			"app",
			"engine",
			"bonding",
			"network",
			"cellular",
			"updates",
			"device",
			"kernel",
		] as const;
		mount(
			logStorage({
				recentVolume: sources.map((source, index) => ({
					source,
					entries: 1,
					bytes: 100 - index,
				})),
			}),
		);

		expect(
			screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim()),
		).toEqual(sources.map((source) => en.systemLogs.source[source]));
	});

	it("shows the sample size but no table when nothing was sampled", () => {
		mount(logStorage({ recentVolume: [], recentSample: 0 }));

		const volume = screen.getByTestId("storage-volume");
		expect(within(volume).getByText(copy.volumeHeading)).toBeTruthy();
		expect(
			within(volume).getByText(fill(copy.volumeSample, { count: "0" })),
		).toBeTruthy();
		expect(within(volume).queryByRole("table")).toBeNull();
	});
});

describe("StorageSection — limits", () => {
	it("disables both limits with a stated reason when the device limit is unknown, keeping Detail editable", async () => {
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({
				ceiling: null,
				retention: { maxAgeDays: null, maxSizeMb: null, detail: "info" },
			}),
		});
		mount(
			logStorage({
				ceiling: null,
				retention: { maxAgeDays: 7, maxSizeMb: 64, detail: "debug" },
			}),
		);

		const notReported = en.systemLogs.versions.notReported;
		expect(
			(screen.getByTestId("storage-save") as HTMLButtonElement).disabled,
		).toBe(true);
		const reasons = document.querySelectorAll('[data-testid$="-reason"]');
		expect(reasons).toHaveLength(1);
		const reason = reasons[0] as HTMLElement;
		expect(reason.textContent?.trim()).toBe(copy.limitsUnknown);
		for (const [trigger, label] of [
			[ageSelect(), fill(copy.keepForDevice, { value: notReported })],
			[sizeSelect(), fill(copy.maxSizeDevice, { value: notReported })],
		] as const) {
			expect((trigger as HTMLButtonElement).disabled).toBe(true);
			expect(trigger.getAttribute("aria-describedby")).toBe(reason.id);
			expect(trigger.textContent?.trim()).toBe(label);
		}

		const reduced = screen.getByRole("radio", { name: copy.detailReduced });
		expect((reduced as HTMLInputElement).disabled).toBe(false);
		await fireEvent.click(reduced);
		await fireEvent.click(screen.getByTestId("storage-save"));

		expect(rpc.logs.setRetention).toHaveBeenCalledExactlyOnceWith({
			maxAgeDays: null,
			maxSizeMb: null,
			detail: "info",
		});
	});

	it("shows no reason and enabled limits when the device reports its limit", () => {
		mount();

		expect(document.querySelectorAll('[data-testid$="-reason"]')).toHaveLength(
			0,
		);
		for (const trigger of [ageSelect(), sizeSelect()]) {
			expect((trigger as HTMLButtonElement).disabled).toBe(false);
			expect(trigger.hasAttribute("aria-describedby")).toBe(false);
		}
	});

	it("offers the device limit, 3, 7 and 14 days and the device's own limit for Keep logs for", async () => {
		mount();

		expect(ageSelect().textContent?.trim()).toBe(
			fill(copy.keepForDevice, { value: "30\u00a0days" }),
		);
		expect(await openOptions(ageSelect())).toEqual([
			fill(copy.keepForDevice, { value: "30\u00a0days" }),
			fill(copy.keepForDays, { count: 3 }),
			fill(copy.keepForDays, { count: 7 }),
			fill(copy.keepForDays, { count: 14 }),
			fill(copy.keepForDays, { count: 30 }),
		]);
	});

	it("leaves out every Keep logs for option above a tighter device limit", async () => {
		mount(logStorage({ ceiling: { maxAgeDays: 10, maxSizeMb: 100 } }));

		expect(await openOptions(ageSelect())).toEqual([
			fill(copy.keepForDevice, { value: "10\u00a0days" }),
			fill(copy.keepForDays, { count: 3 }),
			fill(copy.keepForDays, { count: 7 }),
			fill(copy.keepForDays, { count: 10 }),
		]);
	});

	it("offers the device limit, 32, 64 and 128 MB for Maximum size", async () => {
		mount();

		expect(sizeSelect().textContent?.trim()).toBe(
			fill(copy.maxSizeDevice, { value: "256\u00a0MB" }),
		);
		expect(await openOptions(sizeSelect())).toEqual([
			fill(copy.maxSizeDevice, { value: "256\u00a0MB" }),
			"32\u00a0MB",
			"64\u00a0MB",
			"128\u00a0MB",
		]);
	});

	it("leaves out every Maximum size option above a tighter device limit", async () => {
		mount(logStorage({ ceiling: { maxAgeDays: 10, maxSizeMb: 100 } }));

		expect(await openOptions(sizeSelect())).toEqual([
			fill(copy.maxSizeDevice, { value: "100\u00a0MB" }),
			"32\u00a0MB",
			"64\u00a0MB",
		]);
	});

	it("shows saved limits as the current choice", async () => {
		mount(
			logStorage({
				retention: { maxAgeDays: 14, maxSizeMb: 128, detail: "info" },
			}),
		);

		expect(ageSelect().textContent?.trim()).toBe(
			fill(copy.keepForDays, { count: 14 }),
		);
		expect(sizeSelect().textContent?.trim()).toBe("128\u00a0MB");
		expect(
			(
				screen.getByRole("radio", {
					name: copy.detailReduced,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		await fireEvent.keyDown(ageSelect(), { key: "ArrowDown" });
		const options = await screen.findAllByRole("option");
		expect(
			options
				.filter((option) => option.getAttribute("aria-selected") === "true")
				.map((option) => option.textContent?.trim()),
		).toEqual([fill(copy.keepForDays, { count: 14 })]);
		expect(
			(screen.getByRole("radio", { name: copy.detailFull }) as HTMLInputElement)
				.checked,
		).toBe(false);
	});

	it("explains each detail level in one line", () => {
		mount();

		for (const [name, hint] of [
			[copy.detailFull, copy.detailFullHint],
			[copy.detailReduced, copy.detailReducedHint],
		]) {
			const radio = screen.getByRole("radio", { name });
			expect(radio.getAttribute("aria-describedby")).toBeTruthy();
			const described = document.getElementById(
				radio.getAttribute("aria-describedby") as string,
			);
			expect(described?.textContent?.trim()).toBe(hint);
		}
		expect(screen.getByRole("group", { name: copy.detailLabel })).toBeTruthy();
		expect(
			screen.getByRole("group", { name: copy.limitsHeading }),
		).toBeTruthy();
	});

	it("applies nothing until Save, then saves exactly the chosen limits", async () => {
		const saved = logStorage({
			retention: { maxAgeDays: 7, maxSizeMb: 64, detail: "debug" },
		});
		rpc.logs.setRetention.mockResolvedValue({ ok: true, storage: saved });
		mount();

		const save = screen.getByTestId("storage-save") as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await choose(ageSelect(), fill(copy.keepForDays, { count: 7 }));
		await choose(sizeSelect(), "64\u00a0MB");
		expect(ageSelect().textContent?.trim()).toBe(
			fill(copy.keepForDays, { count: 7 }),
		);
		expect(rpcCalls()).toBe(0);
		expect(save.disabled).toBe(false);

		await fireEvent.click(save);

		expect(rpc.logs.setRetention).toHaveBeenCalledExactlyOnceWith({
			maxAgeDays: 7,
			maxSizeMb: 64,
			detail: "debug",
		});
		const status = screen.getByTestId("storage-save-status");
		await waitFor(() => expect(status.textContent?.trim()).toBe(copy.saved));
		expect(status.getAttribute("role")).toBe("status");
		expect(save.disabled).toBe(true);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "64\u00a0MB" }),
		);
		expect(rpcCalls()).toBe(1);
	});

	it("can return a limit to the device limit", async () => {
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage(),
		});
		mount(
			logStorage({
				retention: { maxAgeDays: 7, maxSizeMb: 64, detail: "debug" },
			}),
		);

		await choose(
			ageSelect(),
			fill(copy.keepForDevice, { value: "30\u00a0days" }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));

		expect(rpc.logs.setRetention).toHaveBeenCalledExactlyOnceWith({
			maxAgeDays: null,
			maxSizeMb: 64,
			detail: "debug",
		});
	});

	it("disables Save again when the choice returns to what is saved", async () => {
		mount();

		const save = screen.getByTestId("storage-save") as HTMLButtonElement;
		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		expect(save.disabled).toBe(false);
		await fireEvent.click(screen.getByRole("radio", { name: copy.detailFull }));
		expect(save.disabled).toBe(true);
	});

	it("disables Save and marks it busy while saving", async () => {
		let settle: (value: unknown) => void = () => {};
		rpc.logs.setRetention.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		mount();

		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		const save = screen.getByTestId("storage-save") as HTMLButtonElement;
		await fireEvent.click(save);
		expect(save.disabled).toBe(true);
		expect(save.getAttribute("aria-busy")).toBe("true");

		settle({ ok: true, storage: logStorage() });
		await waitFor(() => expect(save.getAttribute("aria-busy")).toBe("false"));
		expect(
			(screen.getByRole("radio", { name: copy.detailFull }) as HTMLInputElement)
				.checked,
		).toBe(true);
	});

	it("says the new limit is not met yet when the cleanup it ran left the journal over the limit", async () => {
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({
				retention: { maxAgeDays: null, maxSizeMb: 32, detail: "debug" },
				lastMaintenance: { at: 2_000, ok: true, targetMet: false },
			}),
		});
		mount(
			logStorage({ lastMaintenance: { at: 1_000, ok: true, targetMet: true } }),
		);

		await choose(sizeSelect(), "32\u00a0MB");
		await fireEvent.click(screen.getByTestId("storage-save"));

		const status = screen.getByTestId("storage-save-status");
		await waitFor(() =>
			expect(
				[...status.querySelectorAll("p")].map((line) =>
					line.textContent?.trim(),
				),
			).toEqual([copy.saved, copy.targetNotMet]),
		);
		expect(screen.queryByTestId("storage-save-failed")).toBeNull();
	});

	it("does not repeat an earlier cleanup's result after a save that ran none", async () => {
		const earlier = { at: 1_000, ok: true, targetMet: false };
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({ lastMaintenance: earlier }),
		});
		mount(logStorage({ lastMaintenance: earlier }));

		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));

		const status = screen.getByTestId("storage-save-status");
		await waitFor(() => expect(status.textContent?.trim()).toBe(copy.saved));
	});

	it("offers a retry when the cleanup after saving did not finish", async () => {
		const failedCleanup = logStorage({
			retention: { maxAgeDays: 7, maxSizeMb: null, detail: "debug" },
			lastMaintenance: { at: 2_000, ok: false, targetMet: false },
		});
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: failedCleanup,
		});
		mount();

		await choose(ageSelect(), fill(copy.keepForDays, { count: 7 }));
		await fireEvent.click(screen.getByTestId("storage-save"));

		const band = await screen.findByTestId("storage-save-failed");
		expect(band.getAttribute("role")).toBe("alert");
		expect(within(band).getByText(copy.maintenanceFailed)).toBeTruthy();
		expect(screen.getByTestId("storage-save-status").textContent?.trim()).toBe(
			"",
		);

		await fireEvent.click(
			within(band).getByTestId("storage-save-failed-retry"),
		);
		expect(rpc.logs.setRetention).toHaveBeenCalledTimes(2);
		expect(rpc.logs.setRetention).toHaveBeenLastCalledWith({
			maxAgeDays: 7,
			maxSizeMb: null,
			detail: "debug",
		});
	});

	it("keeps the choice and offers a retry when saving fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.setRetention
			.mockRejectedValueOnce(new Error("Request timeout: logs.setRetention"))
			.mockResolvedValueOnce({ ok: false, error: "INVALID_RETENTION" })
			.mockResolvedValueOnce({
				ok: true,
				storage: logStorage({
					retention: { maxAgeDays: 3, maxSizeMb: null, detail: "debug" },
				}),
			});
		mount();

		await choose(ageSelect(), fill(copy.keepForDays, { count: 3 }));
		await fireEvent.click(screen.getByTestId("storage-save"));

		const band = await screen.findByTestId("storage-save-failed");
		expect(within(band).getByText(copy.actionFailed)).toBeTruthy();
		expect(ageSelect().textContent?.trim()).toBe(
			fill(copy.keepForDays, { count: 3 }),
		);
		expect(screen.getByTestId("storage-save-status").textContent?.trim()).toBe(
			"",
		);

		await fireEvent.click(
			within(band).getByTestId("storage-save-failed-retry"),
		);
		await waitFor(() => expect(rpc.logs.setRetention).toHaveBeenCalledTimes(2));
		expect(await screen.findByTestId("storage-save-failed")).toBeTruthy();

		await fireEvent.click(screen.getByTestId("storage-save-failed-retry"));
		await waitFor(() =>
			expect(screen.queryByTestId("storage-save-failed")).toBeNull(),
		);
		for (const call of rpc.logs.setRetention.mock.calls) {
			expect(call).toEqual([
				{ maxAgeDays: 3, maxSizeMb: null, detail: "debug" },
			]);
		}
		expect(screen.getByTestId("storage-save-status").textContent?.trim()).toBe(
			copy.saved,
		);
	});

	it("clears an earlier save note once the choice changes again", async () => {
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({
				retention: { maxAgeDays: null, maxSizeMb: null, detail: "info" },
			}),
		});
		mount();

		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));
		const status = screen.getByTestId("storage-save-status");
		await waitFor(() => expect(status.textContent?.trim()).toBe(copy.saved));

		await choose(ageSelect(), fill(copy.keepForDays, { count: 3 }));
		expect(status.textContent?.trim()).toBe("");
	});
});

describe("StorageSection — cleanup", () => {
	it("renders nothing for leftover debug files when there are none", () => {
		mount(logStorage({ legacyDebugBytes: 0 }));

		expect(screen.queryByTestId("storage-delete-legacy")).toBeNull();
		expect(document.body.textContent).not.toContain(
			copy.deleteLegacy.split(" (")[0],
		);
	});

	it("deletes leftover debug files and drops the action once they are gone", async () => {
		rpc.logs.deleteLegacyDebug.mockResolvedValue({
			ok: true,
			storage: logStorage({ legacyDebugBytes: 0 }),
		});
		mount(logStorage({ legacyDebugBytes: 2 * MIB }));

		const action = screen.getByTestId("storage-delete-legacy");
		expect(action.textContent?.trim()).toBe(
			fill(copy.deleteLegacy, { size: "2\u00a0MB" }),
		);
		await fireEvent.click(action);

		expect(rpc.logs.deleteLegacyDebug).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(screen.queryByTestId("storage-delete-legacy")).toBeNull(),
		);
		expect(historyChanged).not.toHaveBeenCalled();
	});

	it("offers a retry when deleting leftover debug files fails", async () => {
		rpc.logs.deleteLegacyDebug
			.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" })
			.mockResolvedValueOnce({
				ok: true,
				storage: logStorage({ legacyDebugBytes: 0 }),
			});
		mount(logStorage({ legacyDebugBytes: MIB }));

		await fireEvent.click(screen.getByTestId("storage-delete-legacy"));
		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(within(band).getByText(copy.actionFailed)).toBeTruthy();
		expect(screen.getByTestId("storage-delete-legacy")).toBeTruthy();

		await fireEvent.click(
			within(band).getByTestId("storage-cleanup-failed-retry"),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("storage-delete-legacy")).toBeNull(),
		);
		expect(rpc.logs.deleteLegacyDebug).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("storage-cleanup-failed")).toBeNull();
		expect(historyChanged).not.toHaveBeenCalled();
	});

	it("deletes older log files, states which boots remain and refreshes the history once", async () => {
		rpc.logs.deleteOlderFiles.mockResolvedValue({
			ok: true,
			storage: logStorage({
				journalBytes: 12 * MIB,
				journalDirBytes: 12 * MIB,
			}),
			bootsBefore: 4,
			bootsAfter: 2,
		});
		mount();

		expect(screen.getByText(copy.deleteOlderHint)).toBeTruthy();
		await fireEvent.click(screen.getByTestId("storage-delete-older"));

		const status = screen.getByTestId("storage-cleanup-status");
		await waitFor(() =>
			expect(status.textContent?.trim()).toBe(
				fill(copy.deleteOlderResult, { before: 4, after: 2 }),
			),
		);
		expect(status.getAttribute("role")).toBe("status");
		expect(historyChanged).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "12\u00a0MB", limit: "256\u00a0MB" }),
		);
	});

	it("disables the plain cleanup actions while one runs", async () => {
		let settle: (value: unknown) => void = () => {};
		rpc.logs.deleteOlderFiles.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		mount(logStorage({ legacyDebugBytes: MIB }));

		const older = screen.getByTestId(
			"storage-delete-older",
		) as HTMLButtonElement;
		const legacy = screen.getByTestId(
			"storage-delete-legacy",
		) as HTMLButtonElement;
		await fireEvent.click(older);
		expect(older.disabled).toBe(true);
		expect(older.getAttribute("aria-busy")).toBe("true");
		expect(legacy.disabled).toBe(true);
		expect(legacy.getAttribute("aria-busy")).toBe("false");

		settle({
			ok: true,
			storage: logStorage({ legacyDebugBytes: MIB }),
			bootsBefore: 1,
			bootsAfter: 1,
		});
		await waitFor(() => expect(older.disabled).toBe(false));
		expect(legacy.disabled).toBe(false);
		expect(older.getAttribute("aria-busy")).toBe("false");
	});

	it("reports a failed delete with a retry and leaves the history alone", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.deleteOlderFiles
			.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" })
			.mockRejectedValueOnce(new Error("socket closed"))
			.mockResolvedValueOnce({
				ok: true,
				storage: logStorage(),
				bootsBefore: 3,
				bootsAfter: 3,
			});
		mount();

		await fireEvent.click(screen.getByTestId("storage-delete-older"));
		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(band.getAttribute("role")).toBe("alert");
		expect(within(band).getByText(copy.actionFailed)).toBeTruthy();
		expect(
			screen.getByTestId("storage-cleanup-status").textContent?.trim(),
		).toBe("");

		await fireEvent.click(
			within(band).getByTestId("storage-cleanup-failed-retry"),
		);
		await waitFor(() =>
			expect(rpc.logs.deleteOlderFiles).toHaveBeenCalledTimes(2),
		);
		expect(await screen.findByTestId("storage-cleanup-failed")).toBeTruthy();
		expect(historyChanged).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId("storage-cleanup-failed-retry"));
		await waitFor(() =>
			expect(screen.queryByTestId("storage-cleanup-failed")).toBeNull(),
		);
		expect(historyChanged).toHaveBeenCalledTimes(1);
	});

	it("asks before clearing all logs, in words that promise nothing more than it does", async () => {
		mount();

		await fireEvent.click(screen.getByRole("button", { name: copy.clearAll }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(copy.clearAllTitle)).toBeTruthy();
		expect(within(dialog).getByText(copy.clearAllBody)).toBeTruthy();
		const confirm = within(dialog).getByRole("button", {
			name: copy.clearAllConfirm,
		});
		expect(confirm.className).toContain("text-destructive");
		expect(tokens(dialog)).toContain(WIDE_CONFIRM);
		expect(tokens(dialog)).toEqual(
			expect.arrayContaining(WRAPPING_CONFIRM_BUTTONS),
		);
		await waitFor(() =>
			expect(dialog.contains(document.activeElement)).toBe(true),
		);
		expect(document.activeElement).not.toBe(confirm);
		expect(rpcCalls()).toBe(0);
	});

	it.each([
		[copy.clearAll, copy.clearAllTitle],
		[copy.clearEvents, copy.clearEventsTitle],
	])(
		"opens %s with focus on Cancel, so an immediate Enter cancels",
		async (trigger, title) => {
			mount();

			await fireEvent.click(screen.getByRole("button", { name: trigger }));
			const dialog = await screen.findByRole("alertdialog");
			expect(within(dialog).getByText(title)).toBeTruthy();

			await waitFor(() =>
				expect(document.activeElement).toBe(
					within(dialog).getByRole("button", { name: en.dialog.cancel }),
				),
			);
		},
	);

	it("does nothing when Clear all is cancelled, and the readout stays listed", async () => {
		mount();

		await fireEvent.click(screen.getByRole("button", { name: copy.clearAll }));
		const dialog = await screen.findByRole("alertdialog");
		await fireEvent.click(
			within(dialog).getByRole("button", { name: en.dialog.cancel }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

		expect(rpcCalls()).toBe(0);
		expect(screen.getAllByTestId("storage-volume-row")).toHaveLength(3);
		expect(historyChanged).not.toHaveBeenCalled();
	});

	it("clears all logs once confirmed and refreshes the history once", async () => {
		const cleared = Date.UTC(2026, 10, 15, 12, 0);
		rpc.logs.clearAll.mockResolvedValue({
			ok: true,
			storage: logStorage({
				journalBytes: MIB,
				journalDirBytes: MIB,
				recentVolume: [{ source: "app", entries: 1, bytes: 40 }],
				recentSample: 1,
				lastClearedAt: cleared,
			}),
		});
		mount();

		await confirmAction(copy.clearAll, copy.clearAllConfirm);

		expect(rpc.logs.clearAll).toHaveBeenCalledTimes(1);
		expect(historyChanged).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "1\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(screen.getAllByTestId("storage-volume-row")).toHaveLength(1);
		expect(screen.getByTestId("storage-last-cleared")).toBeTruthy();
		expect(screen.queryByTestId("storage-cleanup-failed")).toBeNull();
	});

	it("shows the update refusal and leaves the data shown", async () => {
		rpc.logs.clearAll.mockResolvedValue({
			ok: false,
			error: "UPDATE_IN_PROGRESS",
		});
		mount();

		await confirmAction(copy.clearAll, copy.clearAllConfirm);

		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(band.getAttribute("role")).toBe("alert");
		expect(within(band).getByText(copy.updateInProgress)).toBeTruthy();
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(screen.getAllByTestId("storage-volume-row")).toHaveLength(3);
		expect(historyChanged).not.toHaveBeenCalled();

		await fireEvent.click(
			within(band).getByTestId("storage-cleanup-failed-retry"),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(copy.clearAllTitle)).toBeTruthy();
		expect(rpc.logs.clearAll).toHaveBeenCalledTimes(1);
		await fireEvent.click(
			within(dialog).getByRole("button", { name: en.dialog.cancel }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await fireEvent.click(screen.getByTestId("storage-cleanup-failed-retry"));
		expect(
			within(await screen.findByRole("alertdialog")).getByText(
				copy.clearAllTitle,
			),
		).toBeTruthy();
		expect(rpc.logs.clearAll).toHaveBeenCalledTimes(1);
	});

	it("reports a failed Clear all without refreshing the history", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.clearAll.mockRejectedValue(
			new Error("Request timeout: logs.clearAll"),
		);
		mount();

		await confirmAction(copy.clearAll, copy.clearAllConfirm);

		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(within(band).getByText(copy.actionFailed)).toBeTruthy();
		expect(historyChanged).not.toHaveBeenCalled();
	});

	it("asks before clearing the event history, then clears it, refreshes the history and re-reads storage", async () => {
		rpc.events.clear.mockResolvedValue({ success: true });
		rpc.logs.getStorage.mockResolvedValue(logStorage({ eventsBytes: 0 }));
		mount();

		await fireEvent.click(
			screen.getByRole("button", { name: copy.clearEvents }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(copy.clearEventsTitle)).toBeTruthy();
		expect(within(dialog).getByText(copy.clearEventsBody)).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: copy.clearEventsConfirm })
				.className,
		).toContain("text-destructive");
		expect(tokens(dialog)).toContain(WIDE_CONFIRM);
		expect(tokens(dialog)).toEqual(
			expect.arrayContaining(WRAPPING_CONFIRM_BUTTONS),
		);
		await fireEvent.click(
			within(dialog).getByRole("button", { name: copy.clearEventsConfirm }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

		expect(rpc.events.clear).toHaveBeenCalledTimes(1);
		expect(historyChanged).toHaveBeenCalledTimes(1);
		expect(rpc.logs.getStorage).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("storage-events").textContent?.trim()).toBe(
			fill(copy.events, { size: "0\u00a0B" }),
		);
	});

	it("reports a refused event clear and offers to ask again", async () => {
		rpc.events.clear.mockResolvedValue({ success: false });
		mount();

		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);

		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(within(band).getByText(copy.actionFailed)).toBeTruthy();
		expect(historyChanged).not.toHaveBeenCalled();
		expect(rpc.logs.getStorage).not.toHaveBeenCalled();

		await fireEvent.click(
			within(band).getByTestId("storage-cleanup-failed-retry"),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(copy.clearEventsTitle)).toBeTruthy();
		expect(rpc.events.clear).toHaveBeenCalledTimes(1);
		await fireEvent.click(
			within(dialog).getByRole("button", { name: en.dialog.cancel }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await fireEvent.click(screen.getByTestId("storage-cleanup-failed-retry"));
		expect(
			within(await screen.findByRole("alertdialog")).getByText(
				copy.clearEventsTitle,
			),
		).toBeTruthy();
		expect(rpc.events.clear).toHaveBeenCalledTimes(1);
	});

	it("clears an earlier outcome when the next action starts", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.deleteOlderFiles.mockResolvedValueOnce({
			ok: true,
			storage: logStorage(),
			bootsBefore: 2,
			bootsAfter: 1,
		});
		rpc.logs.clearAll.mockReturnValue(new Promise(() => {}));
		mount();

		await fireEvent.click(screen.getByTestId("storage-delete-older"));
		const status = screen.getByTestId("storage-cleanup-status");
		await waitFor(() => expect(status.textContent?.trim()).not.toBe(""));

		await fireEvent.click(screen.getByRole("button", { name: copy.clearAll }));
		const dialog = await screen.findByRole("alertdialog");
		await fireEvent.click(
			within(dialog).getByRole("button", { name: copy.clearAllConfirm }),
		);
		await waitFor(() => expect(status.textContent?.trim()).toBe(""));
	});
});

describe("StorageSection — reading storage again", () => {
	it("offers a retry when storage cannot be read after the event history was cleared", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		const failure = new Error("Request timeout: logs.getStorage");
		rpc.logs.getStorage
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(logStorage({ eventsBytes: 0 }));
		mount();

		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);

		const band = await screen.findByTestId("storage-load-failed");
		expect(band.getAttribute("role")).toBe("alert");
		expect(within(band).getByText(copy.loadFailed)).toBeTruthy();
		expect(error).toHaveBeenCalledWith(
			"System Logs storage read failed:",
			failure,
		);
		expect(screen.getByTestId("storage-events").textContent?.trim()).toBe(
			fill(copy.events, { size: "18\u00a0KB" }),
		);

		await fireEvent.click(
			within(band).getByTestId("storage-load-failed-retry"),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("storage-load-failed")).toBeNull(),
		);
		expect(screen.getByTestId("storage-events").textContent?.trim()).toBe(
			fill(copy.events, { size: "0\u00a0B" }),
		);
		expect(rpc.logs.getStorage).toHaveBeenCalledTimes(2);
	});
});

describe("StorageSection — formatting follows the device language", () => {
	it("formats sizes, counts, days and dates for the chosen locale", () => {
		setLocale("de");
		const oldest = Date.UTC(2026, 10, 1, 8, 30);
		mount(
			logStorage({
				journalBytes: 1.5 * MIB,
				journalDirBytes: 2.5 * MIB,
				legacyDebugBytes: 1.5 * MIB,
				oldestEntryTs: oldest,
				lastClearedAt: oldest,
			}),
		);

		const storage = de.systemLogs.storage;
		const days = new Intl.NumberFormat("de", {
			style: "unit",
			unit: "day",
			unitDisplay: "long",
		}).format(30);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(storage.used, { used: "1,5\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(screen.getByTestId("storage-on-disk").textContent?.trim()).toBe(
			fill(storage.onDisk, { total: "2,5\u00a0MB" }),
		);
		expect(screen.getByTestId("storage-oldest").textContent?.trim()).toBe(
			fill(storage.oldest, { date: whole(stamp(oldest, "de")) }),
		);
		expect(screen.getByTestId("storage-last-cleared").textContent?.trim()).toBe(
			fill(storage.lastCleared, { time: whole(stamp(oldest, "de")) }),
		);
		expect(screen.getByTestId("storage-events").textContent?.trim()).toBe(
			fill(storage.events, { size: "18\u00a0KB" }),
		);
		expect(
			screen.getByText(fill(storage.volumeSample, { count: "3.312" })),
		).toBeTruthy();
		expect(
			screen
				.getAllByTestId("storage-volume-row")
				.map((row) =>
					[...row.children].slice(1).map((cell) => cell.textContent?.trim()),
				),
		).toEqual([
			["2.400", "293\u00a0KB"],
			["900", "87,9\u00a0KB"],
			["12", "9,8\u00a0KB"],
		]);
		expect(
			screen
				.getByRole("combobox", { name: storage.keepForLabel })
				.textContent?.trim(),
		).toBe(fill(storage.keepForDevice, { value: whole(days) }));
		expect(
			screen
				.getByRole("combobox", { name: storage.maxSizeLabel })
				.textContent?.trim(),
		).toBe(fill(storage.maxSizeDevice, { value: "256\u00a0MB" }));
		expect(
			screen.getByTestId("storage-delete-legacy").textContent?.trim(),
		).toBe(fill(storage.deleteLegacy, { size: "1,5\u00a0MB" }));
	});
});

describe("StorageSection — extremes", () => {
	it("treats a timestamp no date can show as not reported", () => {
		const beyondDates = 8_640_000_000_000_001;
		mount(
			logStorage({ oldestEntryTs: beyondDates, lastClearedAt: beyondDates }),
		);

		const oldestLine = screen.getByTestId("storage-oldest");
		expect(oldestLine.textContent?.trim()).toBe(copy.oldestUnknown);
		expect(oldestLine.dataset.state).toBe("unknown");
		expect(screen.queryByTestId("storage-last-cleared")).toBeNull();
	});

	it("keeps the usage bar full while the journal is above its limit, and states the real numbers", () => {
		mount(logStorage({ journalBytes: 300 * MIB, journalDirBytes: 300 * MIB }));

		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "300\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(
			(
				screen.getByTestId("storage-usage-meter")
					.firstElementChild as HTMLElement
			).style.width,
		).toBe("100%");
	});

	it("draws an empty bar for an empty journal and still states it", () => {
		mount(logStorage({ journalBytes: 0, journalDirBytes: 0 }));

		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "0\u00a0B", limit: "256\u00a0MB" }),
		);
		expect(
			(
				screen.getByTestId("storage-usage-meter")
					.firstElementChild as HTMLElement
			).style.width,
		).toBe("0%");
	});
});

describe("StorageSection — anatomy", () => {
	it.each([
		[copy.clearAll, copy.clearAllTitle],
		[copy.clearEvents, copy.clearEventsTitle],
	])(
		"keeps Korean words and Japanese phrases whole in the %s confirmation",
		async (trigger, title) => {
			mount();

			await fireEvent.click(screen.getByRole("button", { name: trigger }));
			const dialog = await screen.findByRole("alertdialog");
			expect(within(dialog).getByText(title)).toBeTruthy();
			expect(tokens(dialog)).toEqual(expect.arrayContaining(LINE_BREAKS));
		},
	);

	it.each([[copy.keepForLabel], [copy.maxSizeLabel]])(
		"keeps Korean words and Japanese phrases whole in the %s options",
		async (label) => {
			mount();

			await fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
				key: "ArrowDown",
			});
			expect(tokens(await screen.findByRole("listbox"))).toEqual(
				expect.arrayContaining(LINE_BREAKS),
			);
		},
	);

	it("lays out the section, the usage readout and its meter", () => {
		mount();

		expect(tokens(screen.getByTestId("storage-section"))).toEqual([
			"flex",
			"max-w-2xl",
			"flex-col",
			"gap-6",
			...LINE_BREAKS,
		]);
		const usage = screen.getByTestId("storage-usage");
		expect(tokens(usage)).toEqual(["flex", "flex-col", "gap-5"]);
		const text = screen.getByTestId("storage-usage-text");
		expect(tokens(text)).toEqual(["text-sm", "tabular-nums"]);
		expect(tokens(text.parentElement)).toEqual(["flex", "flex-col", "gap-2"]);
		expect(text.parentElement?.parentElement).toBe(usage);
		const meter = screen.getByTestId("storage-usage-meter");
		expect(tokens(meter)).toEqual([
			"bg-muted",
			"block",
			"h-1.5",
			"min-w-0",
			"grow",
			"overflow-hidden",
			"rounded-full",
		]);
		expect(tokens(meter.firstElementChild)).toEqual([
			"bg-status-neutral",
			"block",
			"h-full",
			"rounded-full",
			"min-w-1",
		]);
		expect(meter.parentElement).toBe(text.parentElement);
	});

	it("draws the on-disk, oldest, event and cleared lines as quiet text", () => {
		mount(logStorage({ journalDirBytes: 300 * MIB, lastClearedAt: 1_000 }));

		const onDisk = screen.getByTestId("storage-on-disk");
		expect(tokens(onDisk)).toEqual(["text-muted-foreground", "text-xs"]);
		expect(onDisk.parentElement).toBe(
			screen.getByTestId("storage-usage-text").parentElement,
		);
		const oldest = screen.getByTestId("storage-oldest");
		expect(tokens(oldest.parentElement)).toEqual([
			"text-muted-foreground",
			"flex",
			"flex-col",
			"gap-1",
			"text-xs",
		]);
		for (const id of [
			"storage-oldest",
			"storage-events",
			"storage-last-cleared",
		]) {
			const line = screen.getByTestId(id);
			expect(line.parentElement).toBe(oldest.parentElement);
			expect(tokens(line)).toEqual([]);
		}
	});

	it("draws recent volume as a compact table with neutral bars", () => {
		mount();

		const volume = screen.getByTestId("storage-volume");
		expect(tokens(volume)).toEqual(["flex", "flex-col", "gap-2"]);
		const heading = within(volume).getByText(copy.volumeHeading);
		expect(tokens(heading)).toEqual(["text-sm", "font-medium"]);
		expect(tokens(heading.parentElement)).toEqual([]);
		expect(tokens(heading.nextElementSibling)).toEqual([
			"text-muted-foreground",
			"text-xs",
		]);
		const table = within(volume).getByRole("table");
		expect(table.getAttribute("aria-labelledby")).toBe(heading.id);
		expect(tokens(table)).toEqual(["w-full", "text-xs"]);
		expect(tokens(table.querySelector("thead"))).toEqual([
			"text-muted-foreground",
		]);
		const headers = within(table).getAllByRole("columnheader");
		expect(headers.map((cell) => tokens(cell))).toEqual([
			["pe-2", "pb-1", "text-start", "font-normal"],
			["pe-2", "pb-1", "text-end", "font-normal"],
			["w-2/5", "pb-1", "text-end", "font-normal"],
		]);
		expect(headers.map((cell) => cell.getAttribute("scope"))).toEqual([
			"col",
			"col",
			"col",
		]);
		expect(tokens(table.querySelector("tbody"))).toEqual(["divide-y"]);
		const [row] = within(table).getAllByTestId("storage-volume-row");
		const [source, entries, size] = [...(row?.children ?? [])];
		expect(source?.getAttribute("scope")).toBe("row");
		expect(tokens(source)).toEqual([
			"py-1.5",
			"pe-2",
			"text-start",
			"font-normal",
		]);
		expect(tokens(entries)).toEqual([
			"py-1.5",
			"pe-2",
			"text-end",
			"tabular-nums",
		]);
		expect(tokens(size)).toEqual(["py-1.5"]);
		const cell = size?.firstElementChild;
		expect(tokens(cell)).toEqual(["flex", "items-center", "gap-2"]);
		const bar = cell?.querySelector('[data-testid="storage-volume-meter"]');
		expect(bar?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(bar)).toEqual(
			tokens(screen.getByTestId("storage-usage-meter")),
		);
		expect(tokens(cell?.lastElementChild)).toEqual([
			"w-14",
			"shrink-0",
			"text-end",
			"tabular-nums",
		]);
	});

	it("lays out the limits form with labelled selects and two separate detail rungs", () => {
		mount(logStorage({ ceiling: null }));

		const limits = screen.getByTestId("storage-limits");
		expect(limits.tagName).toBe("FIELDSET");
		expect(tokens(limits)).toEqual(["min-w-0"]);
		const legend = limits.querySelector(":scope > legend");
		expect(tokens(legend)).toEqual(["text-sm", "font-medium"]);
		expect(legend?.textContent?.trim()).toBe(copy.limitsHeading);
		const body = legend?.nextElementSibling;
		expect(tokens(body)).toEqual(["mt-3", "flex", "flex-col", "gap-4"]);
		for (const [key, name] of [
			["maxAgeDays", copy.keepForLabel],
			["maxSizeMb", copy.maxSizeLabel],
		]) {
			const trigger = screen.getByTestId(`storage-${key}-select`);
			expect(trigger).toBe(screen.getByRole("combobox", { name }));
			expect(tokens(trigger)).toEqual(
				expect.arrayContaining([
					"w-full",
					"data-[size=default]:h-auto",
					"whitespace-normal",
					"py-1.5",
					"text-start",
				]),
			);
			expect(tokens(trigger)).not.toContain("whitespace-nowrap");
			expect(tokens(trigger)).not.toContain("data-[size=default]:h-8");
			const label = document.querySelector(`label[for="${trigger.id}"]`);
			expect(label?.textContent?.trim()).toBe(name);
			expect(tokens(label)).toEqual(
				expect.arrayContaining(["text-muted-foreground", "text-xs"]),
			);
			expect(tokens(label?.parentElement)).toEqual([
				"flex",
				"flex-col",
				"gap-1.5",
			]);
			expect(label?.parentElement?.parentElement).toBe(body);
		}
		const reason = screen.getByTestId("storage-limits-reason");
		expect(tokens(reason)).toEqual(["text-muted-foreground", "text-xs"]);
		expect(reason.parentElement).toBe(body);

		const detail = screen.getByRole("group", { name: copy.detailLabel });
		expect(tokens(detail)).toEqual(["min-w-0"]);
		expect(tokens(detail.querySelector(":scope > legend"))).toEqual([
			"text-muted-foreground",
			"mb-1.5",
			"text-xs",
		]);
		const well = detail.querySelector(":scope > div");
		expect(tokens(well)).toEqual(["flex", "flex-col", "gap-2"]);
		const radios = screen.getAllByRole("radio") as HTMLInputElement[];
		expect(radios.map((radio) => radio.dataset.testid)).toEqual([
			"storage-detail-debug",
			"storage-detail-info",
		]);
		expect(radios.map((radio) => radio.value)).toEqual(["debug", "info"]);
		expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
		expect(radios[0]?.name).toBeTruthy();
		for (const radio of radios) {
			expect(radio.type).toBe("radio");
			expect(tokens(radio)).toEqual([
				"accent-foreground",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]);
			const rung = radio.closest("label");
			expect(rung?.parentElement).toBe(well);
			expect(tokens(rung)).toEqual([
				"has-checked:bg-muted",
				"flex",
				"min-h-(--touch-target-min)",
				"cursor-pointer",
				"items-start",
				"gap-3",
				"rounded-lg",
				"border",
				"px-3",
				"py-2.5",
			]);
			const text = radio.nextElementSibling;
			expect(tokens(text)).toEqual(["flex", "flex-col", "gap-0.5"]);
			expect(tokens(text?.firstElementChild)).toEqual([
				"text-sm",
				"font-medium",
			]);
			expect(tokens(text?.lastElementChild)).toEqual([
				"text-muted-foreground",
				"text-xs",
			]);
		}
	});

	it("draws Save as the primary action with a status line under it", async () => {
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({
				retention: { maxAgeDays: null, maxSizeMb: 32, detail: "debug" },
				lastMaintenance: { at: 2_000, ok: true, targetMet: false },
			}),
		});
		mount();

		const save = screen.getByTestId("storage-save");
		expect(save.textContent?.trim()).toBe(copy.save);
		expect(tokens(save)).toContain("bg-primary");
		expect(tokens(save.parentElement)).toEqual([
			"flex",
			"flex-col",
			"items-start",
			"gap-2",
		]);
		const status = screen.getByTestId("storage-save-status");
		expect(tokens(status)).toEqual(["text-sm"]);
		expect(status.parentElement).toBe(save.parentElement);

		await choose(sizeSelect(), "32\u00a0MB");
		await fireEvent.click(save);
		await waitFor(() => expect(status.querySelectorAll("p")).toHaveLength(2));
		const [saved, notMet] = [...status.querySelectorAll("p")];
		expect(tokens(saved)).toEqual([]);
		expect(tokens(notMet)).toEqual(["text-muted-foreground"]);
	});

	it("draws the cleanup actions as small outline buttons that wrap long labels, after a rule", () => {
		mount(logStorage({ legacyDebugBytes: MIB }));

		const cleanup = screen.getByTestId("storage-cleanup");
		expect(tokens(cleanup)).toEqual([
			"flex",
			"flex-col",
			"gap-4",
			"border-t",
			"pt-5",
		]);
		const older = screen.getByTestId("storage-delete-older");
		expect(older.textContent?.trim()).toBe(copy.deleteOlder);
		expect(tokens(older.parentElement)).toEqual([
			"flex",
			"flex-col",
			"items-start",
			"gap-1.5",
		]);
		expect(tokens(older.nextElementSibling)).toEqual([
			"text-muted-foreground",
			"text-xs",
		]);
		const legacy = screen.getByTestId("storage-delete-legacy");
		expect(tokens(legacy)).toContain("self-start");
		for (const action of [older, legacy]) {
			expect(tokens(action)).toEqual(
				expect.arrayContaining(["border-border", SMALL, ...WRAPS]),
			);
			expect(tokens(action)).not.toContain("whitespace-nowrap");
			expect(action.getAttribute("aria-busy")).toBe("false");
		}
		const triggers = [
			screen.getByRole("button", { name: copy.clearAll }),
			screen.getByRole("button", { name: copy.clearEvents }),
		];
		expect(tokens(triggers[0]?.parentElement)).toEqual([
			"flex",
			"flex-wrap",
			"gap-2",
		]);
		for (const trigger of triggers) {
			expect(trigger.parentElement).toBe(triggers[0]?.parentElement);
			expect(tokens(trigger)).toEqual(
				expect.arrayContaining([
					"border-border",
					SMALL,
					...WRAPS,
					"text-foreground",
					"min-h-(--touch-target-min)",
				]),
			);
			expect(tokens(trigger)).not.toContain("whitespace-nowrap");
			expect(tokens(trigger)).not.toContain("text-primary-foreground");
		}
		const status = screen.getByTestId("storage-cleanup-status");
		expect(tokens(status)).toEqual(["text-sm"]);
		expect(status.parentElement).toBe(cleanup);
	});

	it("names Retry in the device language", async () => {
		setLocale("es");
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.getStorage.mockRejectedValue(
			new Error("Request timeout: logs.getStorage"),
		);
		render(StorageSection);

		const band = await screen.findByTestId("storage-load-failed");
		expect(
			within(band).getByText(es.systemLogs.storage.loadFailed),
		).toBeTruthy();
		expect(
			within(band).getByTestId("storage-load-failed-retry").textContent?.trim(),
		).toBe(es.systemLogs.action.retry);
	});

	it("draws every failure as the amber band with a small outline Retry", async () => {
		rpc.logs.deleteOlderFiles.mockResolvedValue({
			ok: false,
			error: "READ_FAILED",
		});
		mount();

		await fireEvent.click(screen.getByTestId("storage-delete-older"));
		const band = await screen.findByTestId("storage-cleanup-failed");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		const icon = band.querySelector(":scope > svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(icon)).toEqual(
			expect.arrayContaining([
				"text-status-warning",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		const body = icon?.nextElementSibling;
		expect(tokens(body)).toEqual([
			"flex",
			"min-w-0",
			"flex-1",
			"flex-col",
			"items-start",
			"gap-2",
		]);
		const message = within(band).getByText(copy.actionFailed);
		expect(tokens(message)).toEqual(["text-sm"]);
		expect(message.parentElement).toBe(body);
		const retry = within(band).getByTestId("storage-cleanup-failed-retry");
		expect(retry.parentElement).toBe(body);
		expect(retry.textContent?.trim()).toBe(en.systemLogs.action.retry);
		expect(tokens(retry)).toEqual(
			expect.arrayContaining(["gap-1.5", "border-border", "h-7"]),
		);
		const glyph = retry.querySelector("svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(glyph)).toContain("size-4");
		expect(band.parentElement).toBe(screen.getByTestId("storage-cleanup"));
	});
});

describe("StorageSection — owns its initial storage read", () => {
	it("loads a reply when the placeholder mounts it without initial data", async () => {
		let resolveRead: (value: LogStorage) => void = () => {};
		rpc.logs.getStorage.mockReturnValue(
			new Promise<LogStorage>((resolve) => {
				resolveRead = resolve;
			}),
		);
		render(StorageSection);
		const loading = screen.getByTestId("storage-loading");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		expect(loading.getAttribute("role")).toBe("status");
		expect(tokens(loading)).toEqual(["flex", "flex-col", "gap-3"]);
		expect(tokens(within(loading).getByText(en.common.loading))).toEqual([
			"sr-only",
		]);
		expect(
			[...loading.querySelectorAll('[data-slot="skeleton"]')].map((node) =>
				tokens(node).slice(-2),
			),
		).toEqual([
			["h-8", "w-full"],
			["h-12", "w-full"],
			["h-12", "w-full"],
		]);
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
		expect(screen.queryByTestId("storage-usage")).toBeNull();
		resolveRead(logStorage());
		await screen.findByTestId("storage-usage");
		expect(rpc.logs.getStorage).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("storage-loading")).toBeNull();
	});
	it("keeps an initial failure inline and retries the read", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("disconnected"))
			.mockResolvedValueOnce(logStorage());
		render(StorageSection);
		const band = await screen.findByTestId("storage-load-failed");
		expect(within(band).getByText(copy.loadFailed)).toBeTruthy();
		expect(screen.queryByTestId("storage-loading")).toBeNull();
		await fireEvent.click(
			within(band).getByTestId("storage-load-failed-retry"),
		);
		await screen.findByTestId("storage-usage");
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
		expect(rpc.logs.getStorage).toHaveBeenCalledTimes(2);
	});
	it("rejects a malformed reply rather than drawing it as an empty journal", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.getStorage.mockResolvedValue({});
		render(StorageSection);
		await screen.findByTestId("storage-load-failed");
		expect(screen.queryByTestId("storage-usage")).toBeNull();
	});
	it("shows a reply that carries fields a newer device adds", async () => {
		rpc.logs.getStorage.mockResolvedValue({
			...logStorage({ journalBytes: 64 * MIB }),
			addedLater: true,
		});
		render(StorageSection);

		const usage = await screen.findByTestId("storage-usage-text");
		expect(usage.textContent?.trim()).toBe(
			fill(copy.used, { used: "64\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
	});

	it("starts with no recovery band when given a trusted initial reading", () => {
		mount();
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
		expect(rpc.logs.getStorage).not.toHaveBeenCalled();
	});
});

/** Lets every pending promise callback run, then renders what they changed. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve));
	flushSync();
}

/** A storage read the test answers or fails when it chooses. */
function deferredRead() {
	let answer: (value: unknown) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const promise = new Promise((resolve, reject) => {
		answer = resolve;
		fail = reject;
	});
	return { promise, answer, fail };
}

describe("StorageSection — overlapping reads", () => {
	it("keeps Retry disabled while its read is running, so a second click starts no second read", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		const pending = deferredRead();
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("Request timeout: logs.getStorage"))
			.mockReturnValueOnce(pending.promise);
		mount();
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		const retry = within(
			await screen.findByTestId("storage-load-failed"),
		).getByTestId("storage-load-failed-retry") as HTMLButtonElement;

		await fireEvent.click(retry);
		expect(retry.disabled).toBe(true);
		expect(retry.getAttribute("aria-busy")).toBe("true");
		await fireEvent.click(retry);

		expect(rpc.logs.getStorage).toHaveBeenCalledTimes(2);
		pending.answer(logStorage({ journalBytes: 6 * MIB }));
		await waitFor(() =>
			expect(screen.queryByTestId("storage-load-failed")).toBeNull(),
		);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "6\u00a0MB", limit: "256\u00a0MB" }),
		);
	});

	it("never lets a read that answers late replace a newer reply", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		const stale = deferredRead();
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("Request timeout: logs.getStorage"))
			.mockReturnValueOnce(stale.promise);
		rpc.logs.setRetention.mockResolvedValue({
			ok: true,
			storage: logStorage({
				journalBytes: 6 * MIB,
				retention: { maxAgeDays: null, maxSizeMb: null, detail: "info" },
			}),
		});
		mount();
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		await fireEvent.click(
			within(await screen.findByTestId("storage-load-failed")).getByTestId(
				"storage-load-failed-retry",
			),
		);

		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));
		const used = () =>
			screen.getByTestId("storage-usage-text").textContent?.trim();
		const six = fill(copy.used, { used: "6\u00a0MB", limit: "256\u00a0MB" });
		await waitFor(() => expect(used()).toBe(six));

		stale.answer(logStorage({ journalBytes: 48 * MIB }));
		await settled();
		expect(used()).toBe(six);
	});
	/** A Retry read (older) and the read after clearing the event history (newer), both still running. */
	async function overlappingReads() {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		const older = deferredRead();
		const newer = deferredRead();
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("Request timeout: logs.getStorage"))
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		mount();
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		await fireEvent.click(
			within(await screen.findByTestId("storage-load-failed")).getByTestId(
				"storage-load-failed-retry",
			),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: copy.clearEvents }),
		);
		await fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: copy.clearEventsConfirm,
			}),
		);
		await waitFor(() => expect(rpc.logs.getStorage).toHaveBeenCalledTimes(3));
		return { older, newer };
	}
	const used = () =>
		screen.getByTestId("storage-usage-text").textContent?.trim();
	const six = fill(copy.used, { used: "6\u00a0MB", limit: "256\u00a0MB" });

	it("shows the newest read when an older one answers after it", async () => {
		const { older, newer } = await overlappingReads();
		newer.answer(logStorage({ journalBytes: 6 * MIB }));
		await waitFor(() => expect(used()).toBe(six));
		older.answer(logStorage({ journalBytes: 48 * MIB }));
		await settled();
		expect(used()).toBe(six);
	});

	it("keeps Retry disabled and shows the newest read when an older one answers before it", async () => {
		const { older, newer } = await overlappingReads();
		older.answer(logStorage({ journalBytes: 48 * MIB }));
		await settled();
		const retry = within(screen.getByTestId("storage-load-failed")).getByTestId(
			"storage-load-failed-retry",
		) as HTMLButtonElement;
		expect(retry.disabled).toBe(true);
		newer.answer(logStorage({ journalBytes: 6 * MIB }));
		await settled();
		expect(used()).toBe(six);
	});

	it("keeps the newest reply when an older read fails after it", async () => {
		const { older, newer } = await overlappingReads();
		newer.answer(logStorage({ journalBytes: 6 * MIB }));
		await waitFor(() => expect(used()).toBe(six));
		older.fail(new Error("Request timeout: logs.getStorage"));
		await settled();
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
		expect(used()).toBe(six);
	});

	it("reports nothing when an older read fails while a newer one runs", async () => {
		const { older, newer } = await overlappingReads();
		const readFailures = () =>
			vi
				.mocked(console.error)
				.mock.calls.filter(
					([message]) => message === "System Logs storage read failed:",
				).length;
		expect(readFailures()).toBe(1);

		older.fail(new Error("Request timeout: logs.getStorage"));
		await settled();

		expect(readFailures()).toBe(1);
		newer.answer(logStorage({ journalBytes: 6 * MIB }));
		await waitFor(() => expect(used()).toBe(six));
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
	});

	it("keeps the band away after a successful read, even when the failed reading is shown again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("Request timeout: logs.getStorage"))
			.mockResolvedValueOnce(logStorage({ journalBytes: 6 * MIB }));
		const failedOn = logStorage();
		const { rerender } = render(StorageSection, {
			props: { storage: failedOn },
		});
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		await fireEvent.click(
			within(await screen.findByTestId("storage-load-failed")).getByTestId(
				"storage-load-failed-retry",
			),
		);
		await waitFor(() => expect(used()).toBe(six));

		await rerender({ storage: logStorage({ journalBytes: 6 * MIB }) });
		await rerender({ storage: failedOn });

		expect(used()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
	});

	it("lets a read that answers after Storage closed end quietly", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = deferredRead();
		rpc.logs.getStorage.mockReturnValueOnce(pending.promise);
		const { unmount } = render(StorageSection, { props: {} });
		unmount();

		pending.answer(logStorage());
		await settled();
		expect(error).not.toHaveBeenCalled();
	});
});

describe("StorageSection — malformed replies", () => {
	it("offers a retry and keeps the readout when a cleanup reply carries malformed storage", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.logs.clearAll.mockResolvedValue({
			ok: true,
			storage: { journalBytes: "big" },
		});
		mount();

		await confirmAction(copy.clearAll, copy.clearAllConfirm);

		const band = await screen.findByTestId("storage-cleanup-failed");
		const retry = within(band).getByTestId(
			"storage-cleanup-failed-retry",
		) as HTMLButtonElement;
		expect(retry.disabled).toBe(false);
		expect(screen.getByTestId("storage-usage-text").textContent?.trim()).toBe(
			fill(copy.used, { used: "48\u00a0MB", limit: "256\u00a0MB" }),
		);
		expect(historyChanged).not.toHaveBeenCalled();
	});
});

describe("StorageSection — successful replies that leave out what they promise", () => {
	const reading = () =>
		screen.getByTestId("storage-usage-text").textContent?.trim();
	const before = fill(copy.used, { used: "48\u00a0MB", limit: "256\u00a0MB" });

	async function expectRecovery(band: string): Promise<void> {
		const shown = await screen.findByTestId(band);
		const retry = within(shown).getByTestId(`${band}-retry`);
		expect((retry as HTMLButtonElement).disabled).toBe(false);
		expect(reading()).toBe(before);
		expect(screen.queryByTestId("storage-loading")).toBeNull();
	}

	const shapes = (rest: Record<string, unknown>) =>
		[
			["leaves storage out", { ok: true, ...rest }],
			["sends storage as null", { ok: true, storage: null, ...rest }],
			["sends empty storage", { ok: true, storage: {}, ...rest }],
			[
				"sends a storage member of the wrong type",
				{
					ok: true,
					storage: { ...logStorage(), eventsBytes: "18432" },
					...rest,
				},
			],
		] as const;

	const cleanupActions = [
		[
			"Delete older log files",
			() => rpc.logs.deleteOlderFiles,
			() => fireEvent.click(screen.getByTestId("storage-delete-older")),
			{ bootsBefore: 17, bootsAfter: 4 },
		],
		[
			"Delete leftover debug files",
			() => rpc.logs.deleteLegacyDebug,
			() => fireEvent.click(screen.getByTestId("storage-delete-legacy")),
			{},
		],
		[
			"Clear all logs",
			() => rpc.logs.clearAll,
			() => confirmAction(copy.clearAll, copy.clearAllConfirm),
			{},
		],
	] as const;

	it.each(
		cleanupActions.flatMap(([action, call, act, rest]) =>
			shapes(rest).map(
				([shape, reply]) => [action, shape, call, act, reply] as const,
			),
		),
	)(
		"%s: a success that %s offers Retry and keeps the reading",
		async (_action, _shape, call, act, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			call().mockResolvedValue(reply);
			mount(logStorage({ legacyDebugBytes: 5 * MIB }));

			await act();

			await expectRecovery("storage-cleanup-failed");
			expect(historyChanged).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledWith(
				"System Logs storage action failed:",
				expect.anything(),
			);
		},
	);

	it.each([
		["leaves bootsBefore out", { bootsAfter: 4 }],
		["sends bootsAfter as null", { bootsBefore: 17, bootsAfter: null }],
		[
			"sends bootsBefore of the wrong type",
			{ bootsBefore: "17", bootsAfter: 4 },
		],
	])(
		"Delete older log files: a success that %s offers Retry and claims no boot counts",
		async (_shape, boots) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			rpc.logs.deleteOlderFiles.mockResolvedValue({
				ok: true,
				storage: logStorage(),
				...boots,
			});
			mount();

			await fireEvent.click(screen.getByTestId("storage-delete-older"));

			await expectRecovery("storage-cleanup-failed");
			expect(
				screen.getByTestId("storage-cleanup-status").textContent?.trim(),
			).toBe("");
			expect(historyChanged).not.toHaveBeenCalled();
		},
	);

	it.each(shapes({}))(
		"Save limits: a success that %s offers Retry and keeps the reading",
		async (_shape, reply) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			rpc.logs.setRetention.mockResolvedValue(reply);
			mount();

			await fireEvent.click(
				screen.getByRole("radio", { name: copy.detailReduced }),
			);
			await fireEvent.click(screen.getByTestId("storage-save"));

			await expectRecovery("storage-save-failed");
		},
	);

	it.each([
		["leaves success out", {}],
		["sends success as null", { success: null }],
		["sends success of the wrong type", { success: "yes" }],
	])(
		"Clear event history: an answer that %s offers Retry and keeps the reading",
		async (_shape, answer) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			rpc.events.clear.mockResolvedValue(answer);
			mount();

			await confirmAction(copy.clearEvents, copy.clearEventsConfirm);

			await expectRecovery("storage-cleanup-failed");
			expect(historyChanged).not.toHaveBeenCalled();
			expect(rpc.logs.getStorage).not.toHaveBeenCalled();
		},
	);

	it("treats a read that leaves a storage member out as a failed read, with Retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const partial: Record<string, unknown> = { ...logStorage() };
		delete partial.eventsBytes;
		rpc.logs.getStorage.mockResolvedValueOnce(partial);
		render(StorageSection, { props: {} });

		const band = await screen.findByTestId("storage-load-failed");

		const retry = within(band).getByTestId("storage-load-failed-retry");
		expect((retry as HTMLButtonElement).disabled).toBe(false);
		expect(screen.queryByTestId("storage-loading")).toBeNull();
		expect(screen.queryByTestId("storage-usage")).toBeNull();
	});
});

describe("StorageSection — a newer reply retires a failed read", () => {
	const used = () =>
		screen.getByTestId("storage-usage-text").textContent?.trim();
	const six = fill(copy.used, { used: "6\u00a0MB", limit: "256\u00a0MB" });
	const saved = {
		ok: true,
		storage: logStorage({
			journalBytes: 6 * MIB,
			retention: { maxAgeDays: null, maxSizeMb: null, detail: "info" },
		}),
	};

	async function save(): Promise<void> {
		await fireEvent.click(
			screen.getByRole("radio", { name: copy.detailReduced }),
		);
		await fireEvent.click(screen.getByTestId("storage-save"));
	}

	it("hides the read-failure band once a save brings fresh storage", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		rpc.logs.getStorage.mockRejectedValueOnce(
			new Error("Request timeout: logs.getStorage"),
		);
		rpc.logs.setRetention.mockResolvedValue(saved);
		mount();
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		await screen.findByTestId("storage-load-failed");

		await save();

		await waitFor(() => expect(used()).toBe(six));
		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
	});

	it("shows no band when a read that began before a newer reply then fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		rpc.events.clear.mockResolvedValue({ success: true });
		const pending = deferredRead();
		rpc.logs.getStorage
			.mockRejectedValueOnce(new Error("Request timeout: logs.getStorage"))
			.mockReturnValueOnce(pending.promise);
		rpc.logs.setRetention.mockResolvedValue(saved);
		mount();
		await confirmAction(copy.clearEvents, copy.clearEventsConfirm);
		await fireEvent.click(
			within(await screen.findByTestId("storage-load-failed")).getByTestId(
				"storage-load-failed-retry",
			),
		);

		await save();
		await waitFor(() => expect(used()).toBe(six));
		pending.fail(new Error("Request timeout: logs.getStorage"));
		await settled();

		expect(screen.queryByTestId("storage-load-failed")).toBeNull();
		expect(used()).toBe(six);
	});
});

describe("StorageSection — Chinese wraps only between words", () => {
	it("marks the word gaps in every part of Storage, and only in Chinese", () => {
		setLocale("zh");
		mount(logStorage({ legacyDebugBytes: 5 * MIB }));
		const text = screen.getByTestId("storage-section").textContent ?? "";

		expect(text).toContain("日志\u200b占用");
		expect(text).toContain("占用\u200b更多\u200b空间");
		expect(text).toContain("删除\u200b设备");
		expect(text).toContain("最适合排查问题");
		cleanup();

		setLocale("en");
		mount(logStorage({ legacyDebugBytes: 5 * MIB }));
		expect(screen.getByTestId("storage-section").textContent).not.toContain(
			"\u200b",
		);
	});

	it("marks the word gaps in the read-failure band", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		setLocale("zh");
		rpc.logs.getStorage.mockRejectedValueOnce(
			new Error("Request timeout: logs.getStorage"),
		);
		render(StorageSection, { props: {} });

		const band = await screen.findByTestId("storage-load-failed");

		expect(band.textContent).toContain("日志\u200b存储\u200b信息");
		expect(band.textContent).toContain(zh.systemLogs.action.retry);
	});
});
