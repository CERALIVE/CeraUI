// @vitest-environment jsdom

import { setLocale } from "@ceraui/i18n/svelte";
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BOOT_IDS,
	boot,
	fourBoots,
	versions,
} from "$lib/device-logs/__fixtures__/boots";
import { formatBootTime } from "$lib/device-logs/boot-rows";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";

import { en } from "../../tests/helpers/catalog";

import BootPicker from "./BootPicker.svelte";

const boots = vi.hoisted(() => vi.fn<() => Promise<LogBootInfo[]>>());
const rpc = vi.hoisted(() => ({ logs: { boots } }));
vi.mock("$lib/rpc/client", () => ({ rpc }));

const marks = en.systemLogs.boots.mark;
const stops: Array<() => void> = [];

beforeEach(() => {
	boots.mockReset();
	boots.mockResolvedValue(fourBoots());
});

afterEach(() => {
	cleanup();
	for (const stop of stops.splice(0)) stop();
	bootSelection.reset();
	setLocale("en");
	vi.restoreAllMocks();
});

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function tabStores() {
	const events = vi.fn();
	const raw = vi.fn();
	stops.push(bootSelection.onChoose(events), bootSelection.onChoose(raw));
	return { events, raw };
}

function list(): Promise<HTMLElement> {
	return screen.findByRole("listbox", { name: en.systemLogs.boots.heading });
}

function option(bootId: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(
		`[data-testid="boot-option"][data-boot-id="${bootId}"]`,
	);
	if (node === null) throw new Error(`no option for ${bootId}`);
	return node;
}

function allBoots(): HTMLElement {
	return screen.getByTestId("boot-option-all");
}

function quietErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("BootPicker: shutdown marks", () => {
	it("renders four distinct marks with distinct accessible names for current, clean, unclean and unknown", async () => {
		render(BootPicker);
		await list();

		const rendered = (
			[
				[
					BOOT_IDS.current,
					"current",
					marks.current,
					"lucide-circle-dot",
					"text-status-info",
				],
				[
					BOOT_IDS.clean,
					"clean",
					marks.clean,
					"lucide-check",
					"text-muted-foreground",
				],
				[
					BOOT_IDS.unclean,
					"unclean",
					marks.unclean,
					"lucide-triangle-alert",
					"text-status-warning",
				],
				[
					BOOT_IDS.unknown,
					"unknown",
					marks.unknown,
					"lucide-circle-help",
					"text-status-neutral",
				],
			] as const
		).map(([bootId, state, label, glyph, tone]) => {
			const row = option(bootId);
			const mark = row.querySelector<HTMLElement>("[data-boot-mark]");
			expect(mark?.dataset.state).toBe(state);
			expect(mark?.textContent?.trim()).toBe(label);
			const icon = mark?.querySelector("svg");
			expect(icon?.getAttribute("aria-hidden")).toBe("true");
			expect(icon?.getAttribute("class")).toContain(glyph);
			expect(icon?.getAttribute("class")).toContain(tone);
			expect(screen.getByRole("option", { name: new RegExp(label) })).toBe(row);
			return label;
		});
		expect(new Set(rendered).size).toBe(4);
	});

	it("gives the unknown row data-state=unknown, distinct from the clean row, and never the clean mark", async () => {
		render(BootPicker);
		await list();

		const unknown = option(BOOT_IDS.unknown);
		const clean = option(BOOT_IDS.clean);
		expect(unknown.dataset.state).toBe("unknown");
		expect(clean.dataset.state).toBe("clean");
		expect(unknown.dataset.state).not.toBe(clean.dataset.state);
		expect(unknown.textContent).not.toContain(marks.clean);
		expect(
			unknown.querySelector(".lucide-check:not([data-selected-check])"),
		).toBeNull();
	});

	it("shows the device's own mark, even for a boot whose logs are gone", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current"),
			boot(BOOT_IDS.unclean, "unclean", { index: -1, logsAvailable: false }),
		]);
		render(BootPicker);
		await list();

		const row = option(BOOT_IDS.unclean);
		expect(row.dataset.state).toBe("unclean");
		expect(
			row.querySelector<HTMLElement>("[data-boot-mark]")?.dataset.state,
		).toBe("unclean");
	});
});

describe("BootPicker: rows", () => {
	it("lists every boot in the device's order after All boots", async () => {
		render(BootPicker);
		const listbox = await list();

		const options = within(listbox).getAllByRole("option");
		expect(options[0]).toBe(allBoots());
		expect(options[0]?.textContent?.trim()).toBe(en.systemLogs.boots.all);
		expect(options.slice(1).map((node) => node.dataset.bootId)).toEqual([
			BOOT_IDS.current,
			BOOT_IDS.clean,
			BOOT_IDS.unclean,
			BOOT_IDS.unknown,
		]);
	});

	it("keeps a boot whose logs were removed, labelled Logs removed", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current"),
			boot(BOOT_IDS.unknown, "unknown", { index: -1, logsAvailable: false }),
		]);
		render(BootPicker);
		await list();

		expect(
			within(option(BOOT_IDS.unknown))
				.getByTestId("boot-logs-removed")
				.textContent?.trim(),
		).toBe(en.systemLogs.boots.logsRemoved);
		expect(
			within(option(BOOT_IDS.current)).queryByTestId("boot-logs-removed"),
		).toBeNull();
		expect(
			within(option(BOOT_IDS.unknown)).queryByTestId("boot-changed"),
		).toBeNull();
	});

	it("shows each boot's start time, with seconds, as a machine-readable time", async () => {
		render(BootPicker);
		await list();

		const [current] = fourBoots();
		const time = option(BOOT_IDS.current).querySelector("time");
		expect(time?.getAttribute("datetime")).toBe(
			new Date(current?.firstTs ?? 0).toISOString(),
		);
		expect(time?.textContent?.trim()).toBe(
			en.systemLogs.boots.started.replace(
				"{time}",
				formatBootTime(current?.firstTs ?? 0, "en"),
			),
		);
	});

	it("isolates each data param in its own bdi, so right-to-left text cannot reorder it", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: versions(BOOT_IDS.current, "2026.11.3-beta", "b"),
			}),
		]);
		render(BootPicker);
		await list();

		const row = option(BOOT_IDS.current);
		const [current] = fourBoots();
		const isolated = [...row.querySelectorAll("bdi")].map(
			(node) => node.textContent,
		);
		expect(isolated).toEqual([
			formatBootTime(current?.firstTs ?? 0, "en"),
			"2026.11.3-beta",
			"b",
		]);
		for (const node of row.querySelectorAll("bdi")) {
			expect(node.childElementCount).toBe(0);
		}
	});

	it("formats start times in the operator's locale", async () => {
		setLocale("de");
		render(BootPicker);
		await screen.findAllByTestId("boot-option");

		const [current] = fourBoots();
		expect(
			option(BOOT_IDS.current).querySelector("time bdi")?.textContent,
		).toBe(formatBootTime(current?.firstTs ?? 0, "de"));
	});

	it("shows the system image and slot when they were recorded", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: versions(BOOT_IDS.current, "2026.11.3", "b"),
			}),
		]);
		render(BootPicker);
		await list();

		const line = within(option(BOOT_IDS.current)).getByTestId("boot-versions");
		expect(line.textContent).toContain(
			en.systemLogs.boots.systemImage.replace("{version}", "2026.11.3"),
		);
		expect(line.textContent).toContain(
			en.systemLogs.boots.slot.replace("{slot}", "b"),
		);
		expect(line.textContent).not.toContain(en.systemLogs.boots.versionsUnknown);
	});

	it.each([
		["recorded no versions", null],
		["recorded neither image nor slot", versions(BOOT_IDS.clean, null, null)],
	])(
		"says versions were not recorded when the boot %s",
		async (_case, recorded) => {
			boots.mockResolvedValue([
				boot(BOOT_IDS.clean, "clean", { versions: recorded }),
			]);
			render(BootPicker);
			await list();

			const line = within(option(BOOT_IDS.clean)).getByTestId("boot-versions");
			expect(line.textContent?.trim()).toBe(
				en.systemLogs.boots.versionsUnknown,
			);
		},
	);

	it("shows only the part that was recorded", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.clean, "clean", {
				versions: versions(BOOT_IDS.clean, null, "a"),
			}),
			boot(BOOT_IDS.unknown, "unknown", {
				index: -1,
				versions: versions(BOOT_IDS.unknown, "2026.11.2", null),
			}),
		]);
		render(BootPicker);
		await list();

		const slotOnly = within(option(BOOT_IDS.clean)).getByTestId(
			"boot-versions",
		);
		expect(slotOnly.textContent?.trim()).toBe(
			en.systemLogs.boots.slot.replace("{slot}", "a"),
		);
		const imageOnly = within(option(BOOT_IDS.unknown)).getByTestId(
			"boot-versions",
		);
		expect(imageOnly.textContent?.trim()).toBe(
			en.systemLogs.boots.systemImage.replace("{version}", "2026.11.2"),
		);
	});

	it("tags a boot whose system image or slot changed from the boot before it, and describes the tag", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: versions(BOOT_IDS.current, "2026.11.3", "b"),
			}),
			boot(BOOT_IDS.clean, "clean", {
				index: -1,
				versions: versions(BOOT_IDS.clean, "2026.11.2", "a"),
			}),
		]);
		render(BootPicker);
		await list();

		const changed = option(BOOT_IDS.current);
		expect(
			within(changed).getByTestId("boot-changed").textContent?.trim(),
		).toBe(en.systemLogs.boots.changed);
		const describedBy = changed.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const description = document.getElementById(describedBy ?? "");
		expect(description?.textContent?.trim()).toBe(
			en.systemLogs.boots.changedDescription,
		);
		expect(description?.hidden).toBe(true);

		expect(within(changed).queryByTestId("boot-logs-removed")).toBeNull();

		const older = option(BOOT_IDS.clean);
		expect(within(older).queryByTestId("boot-changed")).toBeNull();
		expect(older.hasAttribute("aria-describedby")).toBe(false);
	});

	it("says no earlier boots are stored when only the running boot is listed", async () => {
		boots.mockResolvedValue([boot(BOOT_IDS.current, "current")]);
		render(BootPicker);
		await list();

		expect(screen.getByTestId("boot-picker-empty").textContent?.trim()).toBe(
			en.systemLogs.boots.empty,
		);
	});

	it.each([
		["no boot at all", []],
		["only the running boot", [boot(BOOT_IDS.current, "current")]],
	])("keeps All boots selectable with %s", async (_case, listed) => {
		boots.mockResolvedValue(listed);
		render(BootPicker);
		await list();

		expect(allBoots().getAttribute("aria-selected")).toBe("true");
		expect(screen.getByTestId("boot-picker-empty")).toBeTruthy();
	});

	it("does not say no earlier boots are stored when earlier boots are listed", async () => {
		render(BootPicker);
		await list();

		expect(screen.queryByTestId("boot-picker-empty")).toBeNull();
	});
});

describe("BootPicker: choosing", () => {
	it("notifies both tab stores with the chosen boot id", async () => {
		const { events, raw } = tabStores();
		render(BootPicker);
		await list();

		await fireEvent.click(option(BOOT_IDS.clean));

		expect(events).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.clean);
		expect(raw).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.clean);
		expect(bootSelection.boot?.bootId).toBe(BOOT_IDS.clean);
	});

	it("starts on All boots and clears the boot of both tab stores when All boots is chosen", async () => {
		render(BootPicker);
		await list();
		expect(allBoots().getAttribute("aria-selected")).toBe("true");
		await fireEvent.click(option(BOOT_IDS.unclean));
		const { events, raw } = tabStores();

		await fireEvent.click(allBoots());

		expect(events).toHaveBeenCalledExactlyOnceWith(null);
		expect(raw).toHaveBeenCalledExactlyOnceWith(null);
		expect(allBoots().getAttribute("aria-selected")).toBe("true");
	});

	it("marks only the chosen boot as selected, with a check and a tonal wash", async () => {
		render(BootPicker);
		await list();

		await fireEvent.click(option(BOOT_IDS.unclean));

		const selected = screen
			.getAllByRole("option")
			.filter((node) => node.getAttribute("aria-selected") === "true");
		expect(selected).toEqual([option(BOOT_IDS.unclean)]);
		expect(
			option(BOOT_IDS.unclean).querySelectorAll("[data-selected-check]"),
		).toHaveLength(1);
		expect(document.querySelectorAll("[data-selected-check]")).toHaveLength(1);
		const classes = option(BOOT_IDS.unclean).className.split(/\s+/);
		expect(classes).toContain("aria-selected:bg-muted");
		expect(
			classes.filter((token) =>
				/^aria-selected:(ring|border|outline)/.test(token),
			),
		).toEqual([]);
	});

	it("keeps a slot for the check on every option, so choosing never re-wraps a row", async () => {
		render(BootPicker);
		await list();

		for (const node of screen.getAllByRole("option")) {
			const slot = node.querySelectorAll("[data-check-slot]");
			expect(slot).toHaveLength(1);
			expect(tokens(slot[0])).toEqual([
				"ms-auto",
				"flex",
				"size-4",
				"shrink-0",
			]);
			expect(slot[0]?.parentElement).toBe(node);
		}
		expect(
			allBoots().querySelector("[data-check-slot] [data-selected-check]"),
		).not.toBeNull();
		expect(
			option(BOOT_IDS.clean).querySelector("[data-selected-check]"),
		).toBeNull();
	});

	it("shows a boot chosen before it mounted as selected", async () => {
		const [, clean] = fourBoots();
		if (clean !== undefined) bootSelection.choose(clean);
		render(BootPicker);
		await list();

		expect(option(BOOT_IDS.clean).getAttribute("aria-selected")).toBe("true");
		expect(allBoots().getAttribute("aria-selected")).toBe("false");
	});

	it("tells its host after every choice, so a sheet can close", async () => {
		const onchoose = vi.fn();
		render(BootPicker, { props: { onchoose } });
		await list();

		await fireEvent.click(option(BOOT_IDS.clean));
		await fireEvent.click(allBoots());

		expect(onchoose).toHaveBeenCalledTimes(2);
	});
});

describe("BootPicker: keyboard", () => {
	it("falls back to All boots as the tab stop when the chosen boot is no longer listed", async () => {
		bootSelection.choose(boot("9".repeat(32), "clean"));
		render(BootPicker);
		await list();

		expect(allBoots().tabIndex).toBe(0);
		expect(allBoots().getAttribute("aria-selected")).toBe("false");
		expect(
			screen.getAllByRole("option").filter((node) => node.tabIndex === 0),
		).toEqual([allBoots()]);
	});

	it("is one tab stop, on the selected option", async () => {
		render(BootPicker);
		await list();
		await fireEvent.click(option(BOOT_IDS.clean));

		const stops = screen
			.getAllByRole("option")
			.filter((node) => node.tabIndex === 0);
		expect(stops).toEqual([option(BOOT_IDS.clean)]);
		expect(
			screen.getAllByRole("option").filter((node) => node.tabIndex === -1),
		).toHaveLength(4);
	});

	it("moves focus with the arrow, Home and End keys without choosing", async () => {
		const { raw } = tabStores();
		render(BootPicker);
		await list();
		allBoots().focus();

		await fireEvent.keyDown(allBoots(), { key: "ArrowDown" });
		expect(document.activeElement).toBe(option(BOOT_IDS.current));
		await fireEvent.keyDown(option(BOOT_IDS.current), { key: "End" });
		expect(document.activeElement).toBe(option(BOOT_IDS.unknown));
		await fireEvent.keyDown(option(BOOT_IDS.unknown), { key: "ArrowUp" });
		expect(document.activeElement).toBe(option(BOOT_IDS.unclean));
		await fireEvent.keyDown(option(BOOT_IDS.unclean), { key: "Home" });
		expect(document.activeElement).toBe(allBoots());

		expect(raw).not.toHaveBeenCalled();
	});

	it.each(["Enter", " "])("chooses the focused boot with %j", async (key) => {
		const { raw } = tabStores();
		render(BootPicker);
		await list();

		const handled = await fireEvent.keyDown(option(BOOT_IDS.unclean), { key });

		expect(raw).toHaveBeenCalledExactlyOnceWith(BOOT_IDS.unclean);
		expect(handled).toBe(false);
	});

	it("moves from All boots to the oldest boot with End", async () => {
		render(BootPicker);
		await list();
		allBoots().focus();

		await fireEvent.keyDown(allBoots(), { key: "End" });

		expect(document.activeElement).toBe(option(BOOT_IDS.unknown));
	});

	it.each(["Enter", " "])(
		"clears the boot with %j on All boots",
		async (key) => {
			render(BootPicker);
			await list();
			await fireEvent.click(option(BOOT_IDS.clean));
			const { raw } = tabStores();

			await fireEvent.keyDown(allBoots(), { key });

			expect(raw).toHaveBeenCalledExactlyOnceWith(null);
		},
	);

	it("leaves other keys to the browser", async () => {
		const { raw } = tabStores();
		render(BootPicker);
		await list();
		allBoots().focus();

		const handled = await fireEvent.keyDown(allBoots(), { key: "Tab" });

		expect(handled).toBe(true);
		expect(document.activeElement).toBe(allBoots());
		expect(raw).not.toHaveBeenCalled();
	});

	it("claims the arrow keys so the list does not scroll", async () => {
		render(BootPicker);
		await list();

		expect(await fireEvent.keyDown(allBoots(), { key: "ArrowDown" })).toBe(
			false,
		);
	});
});

describe("BootPicker: anatomy", () => {
	const OPTION = [
		"flex",
		"min-h-(--touch-target-min)",
		"cursor-pointer",
		"items-center",
		"gap-3",
		"rounded-md",
		"px-3",
		"py-2",
		"text-start",
		"outline-none",
		"hover:bg-muted/60",
		"aria-selected:bg-muted",
		"focus-visible:ring-3",
		"focus-visible:ring-ring/50",
	];
	const TAG = [
		"bg-secondary",
		"text-secondary-foreground",
		"rounded-sm",
		"px-1.5",
		"py-0.5",
		"font-medium",
	];

	it("lays out the list, its options and the row lines", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: versions(BOOT_IDS.current, "2026.11.3", "b"),
			}),
			boot(BOOT_IDS.unknown, "unknown", {
				index: -1,
				logsAvailable: false,
				versions: versions(BOOT_IDS.unknown, "2026.11.2", "a"),
			}),
		]);
		render(BootPicker);
		const listbox = await list();

		expect(tokens(screen.getByTestId("boot-picker"))).toEqual([
			"flex",
			"flex-col",
			"gap-3",
			"[word-break:auto-phrase]",
			"[&:lang(ko)]:break-keep",
		]);
		expect(tokens(listbox)).toEqual(["flex", "flex-col", "gap-2"]);
		for (const node of screen.getAllByRole("option"))
			expect(tokens(node)).toEqual(OPTION);
		expect(tokens(allBoots().firstElementChild)).toEqual([
			"text-sm",
			"font-medium",
		]);

		const row = option(BOOT_IDS.current);
		const column = row.firstElementChild;
		expect(tokens(column)).toEqual([
			"flex",
			"min-w-0",
			"flex-1",
			"flex-col",
			"gap-1",
		]);
		expect(tokens(row.querySelector("time"))).toEqual([
			"text-sm",
			"font-medium",
			"text-pretty",
			"tabular-nums",
			"break-keep",
		]);
		expect(
			tokens(row.querySelector("[data-boot-mark]")?.parentElement),
		).toEqual([
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-3",
			"gap-y-1",
			"text-xs",
		]);
		expect(tokens(within(row).getByTestId("boot-versions"))).toEqual([
			"text-muted-foreground",
			"flex",
			"flex-wrap",
			"gap-x-2",
			"[&_bdi]:wrap-anywhere",
		]);
		const mark = row.querySelector("[data-boot-mark]");
		expect(tokens(mark)).toEqual([
			"inline-flex",
			"min-w-0",
			"items-center",
			"gap-1.5",
		]);
		expect(tokens(mark?.querySelector("svg"))).toEqual(
			expect.arrayContaining(["size-4", "shrink-0", "text-status-info"]),
		);

		const removed = within(option(BOOT_IDS.unknown)).getByTestId(
			"boot-logs-removed",
		);
		expect(tokens(removed)).toEqual(TAG);
		expect(tokens(removed.parentElement)).toEqual([
			"flex",
			"flex-wrap",
			"items-center",
			"gap-2",
			"text-xs",
		]);
		const changed = within(row).getByTestId("boot-changed");
		expect(tokens(changed)).toEqual(TAG);
		expect(column?.children).toHaveLength(3);
		expect(option(BOOT_IDS.unknown).firstElementChild?.children).toHaveLength(
			3,
		);
		expect(tokens(allBoots().querySelector("[data-selected-check]"))).toEqual(
			expect.arrayContaining(["text-foreground", "size-4"]),
		);
		expect(
			allBoots()
				.querySelector("[data-selected-check]")
				?.getAttribute("aria-hidden"),
		).toBe("true");
	});

	it("keeps a long recorded version whole and lets it wrap inside its row", async () => {
		const long = `2026.11.3-beta-${"Wiederherstellungsdiagnose".repeat(4)}`;
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: versions(BOOT_IDS.current, long, "b"),
			}),
		]);
		render(BootPicker);
		await list();

		const line = within(option(BOOT_IDS.current)).getByTestId("boot-versions");
		expect(
			[...line.querySelectorAll("bdi")].map((node) => node.textContent),
		).toEqual([long, "b"]);
		expect(tokens(line)).toContain("[&_bdi]:wrap-anywhere");
		expect(tokens(line)).not.toContain("wrap-anywhere");
		expect(line.querySelector(".truncate, [class*='line-clamp']")).toBeNull();
	});

	it("keeps CJK words and sentence endings whole: Korean breaks only between words, Japanese only between phrases", async () => {
		render(BootPicker);
		await list();

		expect(tokens(screen.getByTestId("boot-picker"))).toEqual(
			expect.arrayContaining([
				"[word-break:auto-phrase]",
				"[&:lang(ko)]:break-keep",
			]),
		);
	});

	it("keeps a formatted timestamp's tokens whole in every language, such as 2026年11月16日 and 오전 5:39:07", async () => {
		render(BootPicker);
		await list();

		const times = screen.getByTestId("boot-picker").querySelectorAll("time");
		expect(times.length).toBeGreaterThan(0);
		for (const time of times) expect(tokens(time)).toContain("break-keep");
	});

	it("lets only recorded version values wrap anywhere, never the localized copy", async () => {
		render(BootPicker);
		await list();

		const wrapping = [
			...screen
				.getByTestId("boot-picker")
				.querySelectorAll<HTMLElement>("[class]"),
		].filter((node) =>
			tokens(node).some((token) => token.includes("wrap-anywhere")),
		);
		expect(wrapping.length).toBeGreaterThan(0);
		for (const node of wrapping) {
			expect(node.dataset.testid).toBe("boot-versions");
			expect(
				tokens(node).filter((token) => token.includes("wrap-anywhere")),
			).toEqual(["[&_bdi]:wrap-anywhere"]);
		}
	});

	it("adds no tag line to a boot with nothing to tag", async () => {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current"),
			boot(BOOT_IDS.clean, "clean", { index: -1 }),
		]);
		render(BootPicker);
		await list();

		for (const id of [BOOT_IDS.current, BOOT_IDS.clean]) {
			expect(option(id).firstElementChild?.children).toHaveLength(2);
		}
	});

	it("lays out the empty note", async () => {
		boots.mockResolvedValue([boot(BOOT_IDS.current, "current")]);
		render(BootPicker);
		await list();

		expect(tokens(screen.getByTestId("boot-picker-empty"))).toEqual([
			"text-muted-foreground",
			"px-3",
			"text-xs",
		]);
	});

	it("shapes each loading placeholder like a row: a time line, then a mark and a detail line", () => {
		boots.mockImplementation(() => new Promise<LogBootInfo[]>(() => {}));
		render(BootPicker);

		const loading = screen.getByTestId("boot-picker-loading");
		expect(tokens(loading)).toEqual(["flex", "flex-col", "gap-2"]);
		const rows = [...loading.children].filter((node) => node.tagName === "DIV");
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(tokens(row)).toEqual([
				"flex",
				"flex-col",
				"gap-1.5",
				"px-3",
				"py-2",
			]);
			const [time, detail] = [...row.children];
			expect(tokens(time).slice(-2)).toEqual(["h-4", "w-3/4"]);
			expect(tokens(detail)).toEqual(["flex", "items-center", "gap-1.5"]);
			const [glyph, line] = [...(detail?.children ?? [])];
			expect(tokens(glyph).slice(-3)).toEqual([
				"size-4",
				"shrink-0",
				"rounded-full",
			]);
			expect(tokens(line).slice(-2)).toEqual(["h-3", "w-1/2"]);
		}
	});

	it("draws the failure as the amber recovery band with a small outline Retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		boots.mockRejectedValue(new Error("READ_FAILED"));
		render(BootPicker);

		const band = await screen.findByTestId("boot-picker-failed");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"flex",
			"flex-col",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		const message = band.firstElementChild;
		expect(tokens(message)).toEqual(["flex", "items-start", "gap-2"]);
		const icon = message?.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(icon)).toEqual(
			expect.arrayContaining([
				"text-status-warning",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		expect(
			tokens(within(band).getByText(en.systemLogs.boots.loadFailed)),
		).toEqual(["text-sm"]);
		const retry = within(band).getByTestId("boot-picker-retry");
		expect(tokens(retry)).toEqual(
			expect.arrayContaining(["gap-1.5", "self-start", "h-7", "border-border"]),
		);
		expect(tokens(retry.querySelector("svg"))).toContain("size-4");
	});
});

describe("BootPicker: reading the list", () => {
	it("reads the boots once on mount", async () => {
		render(BootPicker);
		await list();

		expect(boots).toHaveBeenCalledTimes(1);
	});

	it("shows rows-shaped loading placeholders and a hidden status while it reads", () => {
		boots.mockImplementation(() => new Promise<LogBootInfo[]>(() => {}));
		render(BootPicker);

		const loading = screen.getByTestId("boot-picker-loading");
		expect(loading.getAttribute("role")).toBe("status");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		expect(within(loading).getByText(en.common.loading).className).toBe(
			"sr-only",
		);
		expect(loading.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(9);
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the recovery band when the list cannot be read, and Retry reads it again", async () => {
		quietErrors();
		boots.mockRejectedValueOnce(new Error("READ_FAILED"));
		render(BootPicker);

		const band = await screen.findByRole("alert");
		expect(band.dataset.testid).toBe("boot-picker-failed");
		expect(band.className).toContain("bg-status-warning/10");
		expect(within(band).getByText(en.systemLogs.boots.loadFailed)).toBeTruthy();
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(screen.queryByTestId("boot-picker-loading")).toBeNull();

		const retry = within(band).getByTestId("boot-picker-retry");
		expect(retry.textContent?.trim()).toBe(en.systemLogs.action.retry);
		await fireEvent.click(retry);

		expect(await list()).toBeTruthy();
		expect(boots).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("re-reads the boots when stored history is deleted", async () => {
		render(BootPicker);
		await list();
		boots.mockResolvedValueOnce([boot(BOOT_IDS.current, "current")]);

		notifyHistoryChanged();

		expect(await screen.findByTestId("boot-picker-empty")).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(2);
		expect(boots).toHaveBeenCalledTimes(2);
	});

	it("keeps the listed boots behind the band when a re-read fails", async () => {
		quietErrors();
		render(BootPicker);
		await list();
		boots.mockRejectedValueOnce(new Error("READ_FAILED"));

		notifyHistoryChanged();

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(5);
	});

	it("stops re-reading once it unmounts", async () => {
		const { unmount } = render(BootPicker);
		await list();
		unmount();

		notifyHistoryChanged();
		await tick();

		expect(boots).toHaveBeenCalledTimes(1);
	});

	it("contains a client without the boot list procedure", async () => {
		const error = quietErrors();
		const saved = rpc.logs;
		Reflect.deleteProperty(rpc, "logs");
		try {
			render(BootPicker);
			expect(await screen.findByTestId("boot-picker-failed")).toBeTruthy();
			expect(error).toHaveBeenCalledTimes(1);
		} finally {
			rpc.logs = saved;
		}
	});
});
