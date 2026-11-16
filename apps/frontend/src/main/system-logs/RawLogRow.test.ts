// @vitest-environment jsdom
import type { LogEntry } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplayRow } from "$lib/device-logs/raw-rows";

import { en } from "../../tests/helpers/catalog";

import RawLogRow from "./RawLogRow.svelte";

const copyToClipboard = vi.hoisted(() =>
	vi.fn<(text: string) => Promise<boolean>>(),
);
vi.mock("$lib/helpers/clipboard", () => ({ copyToClipboard }));

const TS = Date.UTC(2026, 10, 15, 12, 30, 5);

function entry(patch: Partial<LogEntry> = {}): LogEntry {
	return {
		cursor: "s=1",
		ts: TS,
		bootId: "66d8d1808694489b8c3a3fb4795cab24",
		level: "info",
		source: "app",
		unit: "ceralive.service",
		message: "link wlan0 up",
		truncated: false,
		marker: null,
		...patch,
	};
}

function show(row: DisplayRow, props: Record<string, unknown> = {}) {
	const onToggle = vi.fn();
	const onKeydown = vi.fn();
	const view = render(RawLogRow, {
		row,
		stale: false,
		anchored: false,
		expanded: false,
		focusable: true,
		formatTime: (ts: number) => `T${ts}`,
		formatDate: (ts: number) => `D${ts}`,
		onToggle,
		onKeydown,
		...props,
	});
	return { ...view, onToggle, onKeydown };
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function has(element: Element | null | undefined, ...tokens: string[]): void {
	const classes = (element?.getAttribute("class") ?? "").split(/\s+/);
	for (const token of tokens) expect(classes, token).toContain(token);
}

describe("RawLogRow — entry anatomy", () => {
	it("shows the level glyph by name, the time, the unit and the message", () => {
		show({ kind: "entry", key: "s=1", entry: entry({ level: "error" }) });
		const row = screen.getByTestId("raw-row");
		expect(row.dataset.cursor).toBe("s=1");
		expect(row.dataset.level).toBe("error");
		const glyph = within(row).getByRole("img", {
			name: en.systemLogs.level.error,
		});
		expect(glyph.getAttribute("class")).toContain("text-status-error");
		const time = row.querySelector("time");
		expect(time?.getAttribute("datetime")).toBe(new Date(TS).toISOString());
		expect(time?.textContent).toBe(`T${TS}`);
		expect(time?.className).toContain("tabular-nums");
		expect(time?.className).toContain("font-mono");
		const unit = within(row).getByTestId("raw-row-unit");
		expect(unit.textContent).toBe("ceralive.service");
		expect(unit.getAttribute("dir")).toBe("ltr");
		expect(unit.className).toContain("truncate");
		const message = within(row).getByTestId("raw-row-message");
		expect(message.textContent).toBe("link wlan0 up");
		expect(message.getAttribute("dir")).toBe("ltr");
		expect(message.className).toContain("line-clamp-2");
		expect(message.className).toContain("[overflow-wrap:anywhere]");
		expect(message.className).toContain("text-foreground");
	});

	it.each([
		["warning", en.systemLogs.level.warning, "text-status-warning"],
		["info", en.systemLogs.level.info, "text-muted-foreground"],
		["debug", en.systemLogs.level.debug, "text-muted-foreground"],
	] as const)("names a %s glyph and tints it", (level, name, tint) => {
		show({ kind: "entry", key: "s=1", entry: entry({ level }) });
		const glyph = screen.getByRole("img", { name });
		expect(glyph.getAttribute("class")).toContain(tint);
	});

	it("dims debug messages and every message while stale", () => {
		show({ kind: "entry", key: "s=1", entry: entry({ level: "debug" }) });
		expect(screen.getByTestId("raw-row-message").className).toContain(
			"text-muted-foreground",
		);
		cleanup();
		show(
			{ kind: "entry", key: "s=1", entry: entry({ level: "error" }) },
			{ stale: true },
		);
		expect(screen.getByTestId("raw-row-message").className).toContain(
			"text-muted-foreground",
		);
		expect(screen.getByTestId("raw-row").dataset.stale).toBe("true");
	});

	it("is one button that toggles the row and joins the roving tab order", async () => {
		const { onToggle } = show({ kind: "entry", key: "s=1", entry: entry() });
		const button = screen.getByRole("button");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.tabIndex).toBe(0);
		expect(button.className).toContain("min-h-(--touch-target-min)");
		expect(button.className).toContain("text-start");
		await fireEvent.click(button);
		expect(onToggle).toHaveBeenCalledTimes(1);
		cleanup();
		const keyed = show({ kind: "entry", key: "s=1", entry: entry() });
		await fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowDown" });
		expect(keyed.onKeydown).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ key: "ArrowDown" }),
		);
		cleanup();
		show({ kind: "entry", key: "s=1", entry: entry() }, { focusable: false });
		expect(screen.getByRole("button").tabIndex).toBe(-1);
	});

	it("puts the message on its own line until the panel is wide", () => {
		show({ kind: "entry", key: "s=1", entry: entry() });
		const button = screen.getByRole("button");
		expect(button.className).toContain("grid-cols-[1rem_auto_minmax(0,1fr)]");
		expect(button.className).toContain(
			"@min-[40rem]:grid-cols-[1rem_auto_14ch_minmax(0,1fr)]",
		);
		const message = screen.getByTestId("raw-row-message");
		expect(message.className).toContain("col-span-full");
		expect(message.className).toContain("@min-[40rem]:col-span-1");
	});

	it("highlights the anchor tonally and describes it", () => {
		show({ kind: "entry", key: "s=1", entry: entry() }, { anchored: true });
		const row = screen.getByTestId("raw-row");
		expect(row.className).toContain("bg-status-info/10");
		expect(row.dataset.anchor).toBe("true");
		expect(
			screen.getByRole("button", { description: en.systemLogs.anchor.match }),
		).toBeTruthy();
		// The wash leaves muted text under 4.5:1 in dark, so the anchor's quiet text is foreground.
		for (const quiet of [
			row.querySelector("time"),
			screen.getByTestId("raw-row-unit"),
		]) {
			expect(quiet?.className).toContain("text-foreground");
			expect(quiet?.className).not.toContain("text-muted-foreground");
		}
		cleanup();
		show(
			{
				kind: "entry",
				key: "s=1",
				entry: entry({ level: "debug", truncated: true }),
			},
			{ anchored: true, expanded: true },
		);
		for (const id of ["raw-row-full", "raw-row-truncated"]) {
			expect(screen.getByTestId(id).className).toContain("text-foreground");
			expect(screen.getByTestId(id).className).not.toContain(
				"text-muted-foreground",
			);
		}
	});

	it("does not highlight other rows", () => {
		show({ kind: "entry", key: "s=1", entry: entry() });
		const row = screen.getByTestId("raw-row");
		expect(row.className).not.toContain("bg-status-info/10");
		expect(row.dataset.anchor).toBe("false");
		expect(row.querySelector("time")?.className).toContain(
			"text-muted-foreground",
		);
		expect(screen.getByTestId("raw-row-unit").className).toContain(
			"text-muted-foreground",
		);
		expect(screen.queryByText(en.systemLogs.anchor.match)).toBeNull();
		expect(
			screen.getByRole("button").getAttribute("aria-describedby"),
		).toBeNull();
	});
});

describe("RawLogRow — expanded", () => {
	it.each([
		["debug", false],
		["error", true],
	] as const)(
		"keeps expanded %s text muted when stale is %s",
		(level, stale) => {
			show(
				{ kind: "entry", key: "s=1", entry: entry({ level }) },
				{ expanded: true, stale },
			);
			expect(screen.getByTestId("raw-row-full").className).toContain(
				"text-muted-foreground",
			);
		},
	);

	it("shows the full message and unit with Copy", async () => {
		copyToClipboard.mockResolvedValueOnce(true);
		const long = "x".repeat(400);
		show(
			{
				kind: "entry",
				key: "s=1",
				entry: entry({ message: long, unit: "a-very-long-unit-name.service" }),
			},
			{ expanded: true },
		);
		expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
		expect(screen.queryByTestId("raw-row-message")).toBeNull();
		const detail = screen.getByTestId("raw-row-detail");
		expect(screen.queryByTestId("raw-row-copy-status")).toBeNull();
		const full = within(detail).getByTestId("raw-row-full");
		expect(full.textContent).toBe(long);
		expect(full.getAttribute("dir")).toBe("ltr");
		expect(full.className).toContain("whitespace-pre-wrap");
		expect(full.className).not.toContain("text-muted-foreground");
		expect(
			within(detail)
				.getByText("a-very-long-unit-name.service")
				.getAttribute("dir"),
		).toBe("ltr");
		expect(within(detail).queryByTestId("raw-row-truncated")).toBeNull();
		const copy = within(detail).getByRole("button", {
			name: en.systemLogs.raw.copy,
		});
		await fireEvent.click(copy);
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(long);
		expect((await screen.findByTestId("raw-row-copy-status")).textContent).toBe(
			en.systemLogs.raw.copied,
		);
		expect(screen.getByTestId("raw-row-copy-status").getAttribute("role")).toBe(
			"status",
		);
	});

	it("says when copying failed", async () => {
		copyToClipboard.mockResolvedValueOnce(false);
		show({ kind: "entry", key: "s=1", entry: entry() }, { expanded: true });
		await fireEvent.click(
			screen.getByRole("button", { name: en.systemLogs.raw.copy }),
		);
		expect((await screen.findByTestId("raw-row-copy-status")).textContent).toBe(
			en.systemLogs.raw.copyFailed,
		);
	});

	it("states that a truncated entry was shortened", () => {
		show(
			{ kind: "entry", key: "s=1", entry: entry({ truncated: true }) },
			{ expanded: true },
		);
		expect(screen.getByTestId("raw-row-truncated").textContent).toBe(
			en.systemLogs.raw.truncated,
		);
	});

	it("shows no detail while collapsed", () => {
		show({ kind: "entry", key: "s=1", entry: entry({ truncated: true }) });
		expect(screen.queryByTestId("raw-row-detail")).toBeNull();
	});
});

describe("RawLogRow — anatomy", () => {
	it("lays out a collapsed entry as one button row", () => {
		show({ kind: "entry", key: "s=1", entry: entry() }, { anchored: true });
		const row = screen.getByTestId("raw-row");
		has(row, "border-b");
		const button = within(row).getByRole("button");
		expect(button.getAttribute("type")).toBe("button");
		has(
			button,
			"hover:bg-muted/50",
			"grid",
			"w-full",
			"px-4",
			"py-1.5",
			"items-start",
		);
		has(within(row).getByRole("img"), "size-4", "mt-0.5", "shrink-0");
		// The anchor's quiet text is foreground: muted text on its wash is under 4.5:1 in dark.
		has(row.querySelector("time"), "text-foreground", "text-xs", "leading-5");
		has(
			screen.getByTestId("raw-row-unit"),
			"text-foreground",
			"text-xs",
			"leading-5",
		);
		has(
			screen.getByTestId("raw-row-message"),
			"font-mono",
			"text-xs",
			"leading-5",
		);
		has(screen.getByText(en.systemLogs.anchor.match), "sr-only");
	});

	it("lays out the expanded detail with a small outline Copy", async () => {
		copyToClipboard.mockResolvedValueOnce(true);
		show(
			{ kind: "entry", key: "s=1", entry: entry({ truncated: true }) },
			{ expanded: true },
		);
		const detail = screen.getByTestId("raw-row-detail");
		has(detail, "space-y-2", "px-4", "pb-3", "ps-10");
		has(screen.getByTestId("raw-row-full"), "font-mono", "text-xs");
		const unit = within(detail).getByText("ceralive.service");
		has(unit, "text-muted-foreground", "text-xs", "[overflow-wrap:anywhere]");
		has(
			screen.getByTestId("raw-row-truncated"),
			"text-muted-foreground",
			"text-xs",
		);
		const copy = screen.getByTestId("raw-row-copy");
		has(copy, "h-7", "border-border");
		has(copy.parentElement, "flex", "flex-wrap", "items-center", "gap-2");
		await fireEvent.click(copy);
		has(
			await screen.findByTestId("raw-row-copy-status"),
			"text-muted-foreground",
			"text-xs",
		);
	});
});

describe("RawLogRow — separator rows", () => {
	it("shows journald's suppression notice as a gap, never as a line", () => {
		show({
			kind: "entry",
			key: "s=1",
			entry: entry({ marker: "suppressed", message: "Suppressed 40 messages" }),
		});
		const marker = screen.getByTestId("raw-marker");
		expect(marker.dataset.marker).toBe("suppressed");
		has(marker, "before:bg-border", "after:bg-border", "text-muted-foreground");
		expect(marker.textContent?.trim()).toBe(en.systemLogs.marker.suppressed);
		expect(screen.queryByText("Suppressed 40 messages")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it.each([
		["dropped", en.systemLogs.marker.dropped.replace("{count}", "3")],
		["catchupExceeded", en.systemLogs.marker.catchupExceeded],
		["cursorUnavailable", en.systemLogs.marker.cursorUnavailable],
	] as const)("states a %s marker", (marker, text) => {
		show({ kind: "marker", key: "m", marker, count: 3 });
		const node = screen.getByTestId("raw-marker");
		expect(node.dataset.marker).toBe(marker);
		expect(node.textContent?.trim()).toBe(text);
		expect(node.className).toContain("before:bg-border");
		expect(node.className).toContain("after:bg-border");
		expect(node.className).toContain("text-muted-foreground");
	});

	it("labels a day with a date row", () => {
		show({ kind: "date", key: "d", ts: TS });
		const node = screen.getByTestId("raw-date");
		expect(node.querySelector("time")?.getAttribute("datetime")).toBe(
			new Date(TS).toISOString(),
		);
		expect(node.textContent?.trim()).toBe(`D${TS}`);
		expect(node.className).toContain("before:bg-border");
	});

	it("marks where the device clock changed", () => {
		show({ kind: "clock", key: "c" });
		const node = screen.getByTestId("raw-clock");
		expect(node.textContent?.trim()).toBe(en.systemLogs.marker.clockChanged);
		expect(node.className).toContain("before:bg-border");
	});
});
