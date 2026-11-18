// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type {
	DeviceEvent,
	EventListInput,
	EventListOutput,
	LogAroundInput,
	LogAroundOutput,
	LogBootInfo,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	resetConnectionState,
	setConnectionState,
} from "$lib/components/custom/__fixtures__/connection-state.svelte";
import {
	BOOT_IDS,
	boot,
	fourBoots,
	versions,
} from "$lib/device-logs/__fixtures__/boots";
import {
	aroundPage,
	EVENT_AT,
	event,
	eventPage,
} from "$lib/device-logs/__fixtures__/events";
import { formatBootTime } from "$lib/device-logs/boot-rows";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";
import { eventTime } from "$lib/device-logs/timeline-copy";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import EventsTab from "./EventsTab.svelte";

type Feed = (events: DeviceEvent[]) => void;

const list = vi.hoisted(() =>
	vi.fn<(input: EventListInput) => Promise<EventListOutput>>(),
);
const around = vi.hoisted(() =>
	vi.fn<(input: LogAroundInput) => Promise<LogAroundOutput>>(),
);
const boots = vi.hoisted(() => vi.fn<() => Promise<LogBootInfo[]>>());
const feed = vi.hoisted(() => ({ listener: undefined as Feed | undefined }));

vi.mock("$lib/rpc/client", () => ({
	rpc: { events: { list }, logs: { around, boots } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setEventFeedListener: (listener: Feed | undefined) => {
		feed.listener = listener;
	},
}));

const INLINE = "(min-width: 768px) and (min-height: 601px)";
const ev = en.systemLogs.events;
const t = en.timeline;
let media: MediaQueryControl | undefined;

function viewport(inline: boolean): void {
	media = installMediaQueries((query) => query === INLINE && inline);
}

beforeEach(() => {
	viewport(true);
	list.mockReset();
	around.mockReset();
	boots.mockReset();
	boots.mockResolvedValue(fourBoots());
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	feed.listener = undefined;
	bootSelection.reset();
	resetConnectionState();
	setLocale("en");
	vi.restoreAllMocks();
});

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function has(element: Element | null | undefined, ...expected: string[]): void {
	expect(tokens(element)).toEqual(expect.arrayContaining(expected));
}

function quietErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

function stopped(seq: number, extra: Partial<DeviceEvent> = {}) {
	return event(
		seq,
		"stream_stopped",
		{ cause: "operator", durationSec: 4 },
		extra,
	);
}

async function shown(
	events: DeviceEvent[],
	extra: Partial<EventListOutput> = {},
) {
	list.mockResolvedValueOnce(eventPage(events, extra));
	const onviewraw = vi.fn();
	const view = render(EventsTab, { props: { onviewraw } });
	await screen.findAllByTestId(
		events.length > 0 ? "event-row" : "events-empty",
	);
	return { ...view, onviewraw };
}

function rows(): HTMLElement[] {
	return screen.getAllByTestId("event-row");
}

function row(code: string): HTMLElement {
	const node = rows().find((item) => item.dataset.code === code);
	if (node === undefined) throw new Error(`no row for ${code}`);
	return node;
}

describe("EventsTab — rows", () => {
	it("reads the newest events with only a limit and renders a stopped stream as its title and detail", async () => {
		await shown([stopped(2)]);

		expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
		const item = row("stream_stopped");
		expect(within(item).getByTestId("event-title").textContent).toBe(
			t.stream_stopped.title,
		);
		expect(within(item).getByTestId("event-detail").textContent).toBe(
			t.stream_stopped.detail.operator,
		);
		expect(tokens(within(item).getByTestId("event-title"))).toEqual(
			expect.arrayContaining(["text-sm", "font-semibold", "text-foreground"]),
		);
		expect(tokens(within(item).getByTestId("event-detail"))).toEqual(
			expect.arrayContaining(["text-sm", "text-muted-foreground"]),
		);
	});

	it("draws the severity with its glyph, tone and accessible name, never colour alone", async () => {
		await shown([
			event(3, "stream_stop_failed"),
			event(2, "stream_started"),
			stopped(1),
		]);

		for (const [code, name, glyph, tone] of [
			[
				"stream_stop_failed",
				en.systemLogs.severity.error,
				"lucide-circle-alert",
				"text-status-error",
			],
			[
				"stream_started",
				en.systemLogs.severity.success,
				"lucide-circle-check",
				"text-status-success",
			],
			[
				"stream_stopped",
				en.systemLogs.severity.info,
				"lucide-info",
				"text-muted-foreground",
			],
		] as const) {
			const glyphNode = within(row(code)).getByRole("img", { name });
			const icon = glyphNode.querySelector("svg");
			expect(icon?.getAttribute("class")).toContain(glyph);
			expect(icon?.getAttribute("class")).toContain(tone);
			expect(icon?.getAttribute("aria-hidden")).toBe("true");
		}
	});

	it("gives a code from a newer version the honest title and keeps its code inside the collapsed diagnostics", async () => {
		await shown([
			event(4, "from_the_future", { token: "raw-42" }, { family: "network" }),
		]);

		const item = row("from_the_future");
		expect(within(item).getByTestId("event-title").textContent).toBe(
			t.unknown.title,
		);
		expect(within(item).getByTestId("event-detail").textContent).toBe(
			t.unknown.detail,
		);
		expect(
			within(item).getByRole("img", { name: t.family.network }),
		).toBeTruthy();
		const toggle = within(item).getByTestId("event-diagnostics-toggle");
		const body = within(item).getByTestId("event-diagnostics-body");
		expect(toggle.textContent?.trim()).toBe(ev.diagnostics);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(body.id);
		expect(body.id).not.toBe("");
		expect(body.hidden).toBe(true);
		expect(body.textContent).toContain("Event code: from_the_future");
		expect(body.querySelector("dl")).toBeNull();
		// A quiet action beside View raw logs, never a bordered card nested in the row.
		expect(toggle.parentElement).toBe(
			within(item).getByRole("button", { name: ev.viewRaw }).parentElement,
		);
		expect(tokens(toggle)).toEqual(
			expect.arrayContaining([
				"dark:hover:bg-muted/50",
				"h-7",
				"gap-1",
				"text-muted-foreground",
			]),
		);
		expect(toggle.querySelector("svg")?.getAttribute("class")).toContain(
			"lucide-chevron-down",
		);
		expect(tokens(toggle.querySelector("svg"))).not.toContain("rotate-180");
		expect(tokens(body)).toEqual(
			expect.arrayContaining([
				"bg-muted/50",
				"rounded-md",
				"px-3",
				"py-2",
				"text-xs",
			]),
		);
		expect(tokens(body)).not.toContain("border");
		const outside = item.cloneNode(true) as HTMLElement;
		for (const node of outside.querySelectorAll('[data-testid*="diagnostic"]'))
			node.remove();
		expect(outside.textContent).not.toContain("from_the_future");
		expect(item.textContent).not.toContain("raw-42");

		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(body.hidden).toBe(false);
		expect(tokens(toggle.querySelector("svg"))).toContain("rotate-180");

		await fireEvent.click(toggle);
		expect(body.hidden).toBe(true);
	});

	it("gives a row no Diagnostics when the sentence shows everything the record holds", async () => {
		await shown([stopped(2)]);

		expect(
			within(row("stream_stopped")).queryByTestId("event-diagnostics-toggle"),
		).toBeNull();
		expect(
			within(row("stream_stopped")).queryByTestId("event-diagnostics-body"),
		).toBeNull();
	});

	it("keeps a known code's title and shows no detail when a param has the wrong type", async () => {
		await shown([
			event(5, "stream_stopped", { cause: 7, durationSec: "long" }),
		]);

		const item = row("stream_stopped");
		expect(within(item).getByTestId("event-title").textContent).toBe(
			t.stream_stopped.title,
		);
		expect(within(item).queryByTestId("event-detail")).toBeNull();
		expect(
			within(item).getByTestId("event-diagnostics-body").textContent,
		).toContain("Event code: stream_stopped");
	});

	it("lists a raw token the sentence hides only inside the diagnostics, left to right", async () => {
		await shown([
			event(6, "update_refused", { id: "u1", reason: "streaming_active" }),
		]);

		const item = row("update_refused");
		const body = within(item).getByTestId("event-diagnostics-body");
		const value = within(body).getByText("streaming_active");
		expect(value.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
		expect(within(body).getByText("reason:")).toBeTruthy();
		const outside = item.cloneNode(true) as HTMLElement;
		for (const node of outside.querySelectorAll('[data-testid*="diagnostic"]'))
			node.remove();
		expect(outside.textContent).not.toContain("streaming_active");
	});

	it("isolates each data param in a <bdi>", async () => {
		await shown([
			event(7, "link_down", {
				iface: "wwan0",
				kind: "cellular",
				displayName: "Modem 1",
				reason: "probe_failed",
			}),
		]);

		const detail = within(row("link_down")).getByTestId("event-detail");
		expect(
			[...detail.querySelectorAll("bdi")].map((node) => node.textContent),
		).toEqual(["Modem 1"]);
		expect(detail.textContent).toBe(
			"Modem 1 stopped answering internet checks.",
		);
	});

	it("names a modem from the history it recorded", async () => {
		await shown([
			event(9, "modem_connected", { modemKey: "k1", roaming: true }),
			event(8, "modem_added", { modemKey: "k1", name: "EM12" }),
		]);

		expect(
			within(row("modem_connected")).getByTestId("event-detail").textContent,
		).toBe("EM12 connected while roaming.");
	});

	it("states how many similar events were folded in", async () => {
		await shown([stopped(2, { suppressed: 3 }), stopped(1)]);

		const [folded, plain] = rows();
		const note = within(folded as HTMLElement).getByTestId("event-folded");
		expect(note.textContent).toBe("Similar events folded in: 3");
		expect(note.querySelector("bdi")?.textContent).toBe("3");
		expect(
			within(plain as HTMLElement).queryByTestId("event-folded"),
		).toBeNull();
	});

	it("shows the absolute and relative time inside one <time datetime>", async () => {
		await shown([stopped(2)]);

		const time = row("stream_stopped").querySelector("time");
		const expected = eventTime(stopped(2).at, "en");
		expect(time?.getAttribute("datetime")).toBe(expected.iso);
		expect([...(time?.children ?? [])].map((node) => node.textContent)).toEqual(
			[expected.absolute, expected.relative],
		);
		expect(tokens(time)).toEqual(
			expect.arrayContaining([
				"tabular-nums",
				"text-xs",
				"text-muted-foreground",
			]),
		);
		expect(tokens(time?.parentElement)).toEqual(
			expect.arrayContaining(["flex-col", "md:flex-row", "md:justify-between"]),
		);
	});
});

describe("EventsTab — boot separators", () => {
	const minute = 60_000;

	it("heads each boot's rows with its start, system image, slot, shutdown mark and Changed tag", async () => {
		const [current, clean] = fourBoots();
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				...current,
				versions: versions(BOOT_IDS.current, "2026.11.3-beta", "b"),
			}),
			boot(BOOT_IDS.clean, "clean", {
				...clean,
				versions: versions(BOOT_IDS.clean, "2026.11.2", "a"),
			}),
		]);
		await shown([
			stopped(3),
			stopped(2, { bootId: BOOT_IDS.clean, at: EVENT_AT - 9 * minute }),
		]);

		const headings = await screen.findAllByRole("heading", { level: 3 });
		await waitFor(() =>
			expect(headings[0]?.querySelector("[data-boot-mark]")).toBeTruthy(),
		);
		expect(headings).toHaveLength(2);
		const [newest, older] = headings as [HTMLElement, HTMLElement];
		expect(newest.querySelector("time")?.textContent).toBe(
			`Boot started ${formatBootTime(current?.firstTs ?? 0, "en")}`,
		);
		expect(newest.querySelector("time bdi")?.textContent).toBe(
			formatBootTime(current?.firstTs ?? 0, "en"),
		);
		expect(newest.textContent).toContain("System image 2026.11.3-beta");
		expect(newest.textContent).toContain("Slot b");
		expect(
			newest.querySelector("[data-boot-mark]")?.getAttribute("data-state"),
		).toBe("current");
		expect(within(newest).getByText(en.systemLogs.boots.changed)).toBeTruthy();
		expect(
			older.querySelector("[data-boot-mark]")?.getAttribute("data-state"),
		).toBe("clean");
		expect(within(older).queryByText(en.systemLogs.boots.changed)).toBeNull();
		const section = newest.closest("section");
		expect(newest.id).not.toBe("");
		expect(section?.getAttribute("aria-labelledby")).toBe(newest.id);
		expect(tokens(newest)).toEqual(
			expect.arrayContaining(["sticky", "top-0", "bg-muted", "border-y"]),
		);
		const sections = screen.getAllByTestId("events-boot");
		expect(sections.map((node) => node.dataset.bootId)).toEqual([
			BOOT_IDS.current,
			BOOT_IDS.clean,
		]);
		expect(
			within(sections[1] as HTMLElement).getAllByTestId("event-row"),
		).toHaveLength(1);
	});

	it("says a boot's versions were not recorded when the device lists no such boot", async () => {
		boots.mockResolvedValue([]);
		await shown([stopped(1, { bootId: "e".repeat(32) })]);

		const heading = await screen.findByRole("heading", { level: 3 });
		await waitFor(() =>
			expect(heading.textContent).toBe(en.systemLogs.boots.versionsUnknown),
		);
	});

	it("says the boot list could not be read rather than guessing", async () => {
		quietErrors();
		boots.mockRejectedValue(new Error("down"));
		await shown([stopped(1)]);

		const heading = await screen.findByRole("heading", { level: 3 });
		await waitFor(() =>
			expect(heading.textContent).toBe(en.systemLogs.boots.loadFailed),
		);
	});

	it("holds a placeholder in the heading while the boots load", async () => {
		boots.mockReturnValue(new Promise(() => {}));
		await shown([stopped(1)]);

		const heading = screen.getByRole("heading", { level: 3 });
		expect(heading.textContent?.trim()).toBe(en.common.loading);
		expect(heading.querySelector('[data-slot="skeleton"]')).toBeTruthy();
	});

	it("marks where the device clock ran backwards between two rows of one boot", async () => {
		await shown([
			stopped(2, { at: EVENT_AT }),
			stopped(1, { at: EVENT_AT + minute }),
		]);

		const marker = screen.getByTestId("events-clock");
		expect(marker.textContent?.trim()).toBe(en.systemLogs.marker.clockChanged);
		expect(marker.tagName).toBe("LI");
		expect(
			rows().map(
				(item) => item.nextElementSibling?.getAttribute("data-testid") ?? null,
			),
		).toEqual(["events-clock", null]);
	});
});

describe("EventsTab — pushed events", () => {
	it("prepends a pushed event and never shows one twice", async () => {
		await shown([stopped(1)]);

		feed.listener?.([event(2, "stream_started")]);
		await tick();
		feed.listener?.([event(2, "stream_started")]);
		await tick();

		expect(rows().map((item) => item.dataset.code)).toEqual([
			"stream_started",
			"stream_stopped",
		]);
	});

	it("reads the list again when a pushed seq shows events were missed", async () => {
		await shown([stopped(1)]);
		list.mockResolvedValueOnce(
			eventPage([event(5, "internet_lost"), stopped(1)]),
		);

		feed.listener?.([event(5, "internet_lost")]);

		await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		expect(await screen.findByText(t.internet_lost.title)).toBeTruthy();
	});

	it("keeps an event pushed while the list is read again", async () => {
		await shown([stopped(1)]);
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValueOnce(reply.promise);

		notifyHistoryChanged();
		feed.listener?.([event(2, "internet_lost")]);
		reply.resolve(eventPage([stopped(1)]));

		expect(await screen.findByText(t.internet_lost.title)).toBeTruthy();
		expect(rows().map((item) => item.dataset.code)).toEqual([
			"internet_lost",
			"stream_stopped",
		]);
	});

	it("stops listening for pushed events when it unmounts", async () => {
		const view = await shown([stopped(1)]);
		expect(feed.listener).toBeTypeOf("function");

		view.unmount();

		expect(feed.listener).toBeUndefined();
	});
});

describe("EventsTab — filters", () => {
	it("offers one chip per family and Problems only, inline on a roomy screen", async () => {
		await shown([stopped(1)]);

		const group = screen.getByRole("group", { name: ev.families });
		const chips = within(group).getAllByRole("button");
		expect(chips.map((node) => node.textContent?.trim())).toEqual([
			t.family.stream,
			t.family.network,
			t.family.cellular,
			t.family.update,
			t.family.device,
			t.family.capture,
		]);
		for (const chip of chips) {
			expect(chip.getAttribute("aria-pressed")).toBe("false");
			expect(tokens(chip)).toContain("min-h-(--touch-target-min)");
		}
		expect(
			screen
				.getByRole("button", { name: ev.problemsOnly })
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(screen.queryByTestId("events-filter-toggle")).toBeNull();
	});

	it("sends families for the chips chosen and problemsOnly for Problems only", async () => {
		await shown([stopped(1)]);
		list.mockResolvedValue(eventPage([stopped(1)]));

		await fireEvent.click(
			screen.getByRole("button", { name: t.family.network }),
		);
		expect(list).toHaveBeenLastCalledWith({
			limit: 100,
			families: ["network"],
		});
		expect(
			screen
				.getByRole("button", { name: t.family.network })
				.getAttribute("aria-pressed"),
		).toBe("true");

		await fireEvent.click(
			screen.getByRole("button", { name: ev.problemsOnly }),
		);
		expect(list).toHaveBeenLastCalledWith({
			limit: 100,
			families: ["network"],
			problemsOnly: true,
		});
		expect(
			screen
				.getByRole("button", { name: ev.problemsOnly })
				.getAttribute("aria-pressed"),
		).toBe("true");

		await fireEvent.click(
			screen.getByRole("button", { name: ev.problemsOnly }),
		);
		expect(list).toHaveBeenLastCalledWith({
			limit: 100,
			families: ["network"],
		});
	});

	it("folds the filters behind a Filter button on a narrow or short screen", async () => {
		viewport(false);
		await shown([stopped(1)]);

		const toggle = screen.getByTestId("events-filter-toggle");
		expect(toggle.textContent?.trim()).toBe(ev.filter);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		const panel = document.getElementById(
			toggle.getAttribute("aria-controls") ?? "",
		);
		expect(panel?.hidden).toBe(true);

		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel?.hidden).toBe(false);
		expect(
			within(panel as HTMLElement).getByRole("group", { name: ev.families }),
		).toBeTruthy();
		expect(toggle.hasAttribute("data-active")).toBe(false);

		list.mockResolvedValue(eventPage([]));
		await fireEvent.click(
			within(panel as HTMLElement).getByRole("button", {
				name: ev.problemsOnly,
			}),
		);
		expect(toggle.hasAttribute("data-active")).toBe(true);
	});

	it("starts on the boot chosen in the boot picker and follows a new choice", async () => {
		const [, clean] = fourBoots();
		bootSelection.choose(clean ?? null);
		await shown([stopped(1, { bootId: BOOT_IDS.clean })]);
		expect(list).toHaveBeenLastCalledWith({
			limit: 100,
			bootId: BOOT_IDS.clean,
		});

		list.mockResolvedValue(eventPage([]));
		bootSelection.choose(null);
		expect(list).toHaveBeenLastCalledWith({ limit: 100 });
	});
});

describe("EventsTab — View raw logs", () => {
	it("asks for the raw entries around the event and hands them to the shell", async () => {
		const target = stopped(3, { at: EVENT_AT + 5 });
		const { onviewraw } = await shown([target]);
		const page = aroundPage(true);
		around.mockResolvedValue(page);

		const action = within(row("stream_stopped")).getByRole("button", {
			name: ev.viewRaw,
		});
		expect(tokens(action)).toEqual(
			expect.arrayContaining(["dark:hover:bg-muted/50", "h-7", "-ms-2.5"]),
		);
		expect(tokens(action)).not.toContain("border-border");
		await fireEvent.click(action);

		await waitFor(() =>
			expect(onviewraw).toHaveBeenCalledExactlyOnceWith(page),
		);
		expect(around).toHaveBeenCalledExactlyOnceWith({
			bootId: target.bootId,
			at: target.at,
			eventId: target.id,
		});
	});

	it("is disabled while the request runs, keeping its place", async () => {
		await shown([stopped(3)]);
		around.mockReturnValue(new Promise(() => {}));

		const action = within(row("stream_stopped")).getByRole("button", {
			name: ev.viewRaw,
		});
		await fireEvent.click(action);

		// aria-disabled, not disabled: the button keeps keyboard focus while it waits.
		expect(action.getAttribute("aria-disabled")).toBe("true");
		expect(action.getAttribute("aria-busy")).toBe("true");
		expect(action.hasAttribute("disabled")).toBe(false);
		expect(tokens(action)).toEqual(
			expect.arrayContaining([
				"aria-disabled:pointer-events-none",
				"aria-disabled:opacity-50",
			]),
		);
		await fireEvent.click(action);
		expect(around).toHaveBeenCalledOnce();
		expect(
			within(row("stream_stopped")).queryByTestId("event-raw-note"),
		).toBeNull();
	});

	it("hands nothing to the shell when the raw logs arrive after it unmounts", async () => {
		const gone = await shown([stopped(3)]);
		const late = Promise.withResolvers<LogAroundOutput>();
		around.mockReturnValueOnce(late.promise);
		await fireEvent.click(
			within(row("stream_stopped")).getByRole("button", { name: ev.viewRaw }),
		);
		gone.unmount();
		late.resolve(aroundPage(true));

		// A later tab's reply runs the same path after this one, so once it opens, the unmounted tab has handled its reply.
		const later = await shown([stopped(3)]);
		const page = aroundPage();
		around.mockResolvedValueOnce(page);
		await fireEvent.click(
			within(row("stream_stopped")).getByRole("button", { name: ev.viewRaw }),
		);
		await waitFor(() =>
			expect(later.onviewraw).toHaveBeenCalledExactlyOnceWith(page),
		);

		expect(gone.onviewraw).not.toHaveBeenCalled();
	});

	it.each([
		["BOOT_UNAVAILABLE", ev.rawRemoved, null],
		["BUSY", en.systemLogs.error.busy, "alert"],
		["READ_FAILED", en.systemLogs.error.readFailed, "alert"],
	] as const)("states %s on the row", async (error, copy, role) => {
		const { onviewraw } = await shown([stopped(3), stopped(2)]);
		around.mockResolvedValue({ ok: false, error });

		const [first, second] = rows() as [HTMLElement, HTMLElement];
		await fireEvent.click(
			within(first).getByRole("button", { name: ev.viewRaw }),
		);

		const note = await within(first).findByTestId("event-raw-note");
		expect(note.textContent).toBe(copy);
		expect(note.getAttribute("role")).toBe(role);
		has(note, "text-sm");
		expect(within(second).queryByTestId("event-raw-note")).toBeNull();
		expect(onviewraw).not.toHaveBeenCalled();
	});
});

describe("EventsTab — states", () => {
	it("shows skeleton rows and a hidden status while the first page loads", () => {
		list.mockReturnValue(new Promise(() => {}));
		render(EventsTab, { props: { onviewraw: vi.fn() } });

		const loading = screen.getByTestId("events-loading");
		expect(loading.getAttribute("role")).toBe("status");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		expect(
			within(loading).getByText(en.systemLogs.loading.events).className,
		).toContain("sr-only");
		expect(
			loading.querySelectorAll('[data-slot="skeleton"]').length,
		).toBeGreaterThan(0);
	});

	it("teaches what will appear when nothing has been recorded", async () => {
		await shown([]);

		const empty = screen.getByTestId("events-empty");
		expect(within(empty).getByText(ev.emptyTitle)).toBeTruthy();
		expect(within(empty).getByText(ev.emptyBody)).toBeTruthy();
		expect(within(empty).queryByRole("button")).toBeNull();
		expect(screen.queryByTestId("events-end")).toBeNull();
	});

	it("states the end of the stored history under a single event", async () => {
		await shown([stopped(1)]);

		expect(screen.getByTestId("events-end").textContent?.trim()).toBe(
			ev.noOlder,
		);
	});

	it("Show all events also clears the family chips", async () => {
		await shown([stopped(1)]);
		list.mockResolvedValueOnce(eventPage([]));
		await fireEvent.click(
			screen.getByRole("button", { name: t.family.update }),
		);
		const empty = await screen.findByTestId("events-empty");
		list.mockResolvedValue(eventPage([stopped(1)]));

		await fireEvent.click(
			within(empty).getByRole("button", { name: ev.showAll }),
		);

		expect(list).toHaveBeenLastCalledWith({ limit: 100 });
		expect(
			screen
				.getByRole("button", { name: t.family.update })
				.getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("offers Show all events when the filters match nothing, clearing the chosen boot too", async () => {
		const [, clean] = fourBoots();
		bootSelection.choose(clean ?? null);
		await shown([]);

		const empty = screen.getByTestId("events-empty");
		expect(within(empty).getByText(ev.emptyFiltered)).toBeTruthy();
		list.mockResolvedValue(eventPage([stopped(1)]));
		await fireEvent.click(
			within(empty).getByRole("button", { name: ev.showAll }),
		);

		expect(list).toHaveBeenLastCalledWith({ limit: 100 });
		expect(bootSelection.bootId).toBeNull();
		expect(await screen.findByText(t.stream_stopped.title)).toBeTruthy();
	});

	it("shows a recovery band with Retry when the history cannot be read", async () => {
		quietErrors();
		list.mockRejectedValueOnce(new Error("down"));
		render(EventsTab, { props: { onviewraw: vi.fn() } });

		const band = await screen.findByRole("alert");
		expect(band.textContent).toContain(ev.loadFailed);
		expect(tokens(band)).toEqual(
			expect.arrayContaining([
				"border-status-warning/30",
				"bg-status-warning/10",
			]),
		);
		expect(screen.queryByTestId("events-empty")).toBeNull();
		list.mockResolvedValueOnce(eventPage([stopped(1)]));
		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.action.retry }),
		);

		expect(await screen.findByText(t.stream_stopped.title)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("loads older events with beforeSeq and states the end of the stored history", async () => {
		await shown([stopped(9)], { nextBeforeSeq: 9 });
		expect(screen.queryByText(ev.noOlder)).toBeNull();
		list.mockResolvedValueOnce(eventPage([stopped(4)], { headSeq: 9 }));

		await fireEvent.click(screen.getByRole("button", { name: ev.loadOlder }));

		expect(list).toHaveBeenLastCalledWith({ limit: 100, beforeSeq: 9 });
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(screen.queryByRole("button", { name: ev.loadOlder })).toBeNull();
		expect(screen.getByText(ev.noOlder)).toBeTruthy();
	});

	it("keeps the rows and offers Retry when an older page cannot be read", async () => {
		quietErrors();
		await shown([stopped(9)], { nextBeforeSeq: 9 });
		list.mockRejectedValueOnce(new Error("down"));

		await fireEvent.click(screen.getByRole("button", { name: ev.loadOlder }));

		const band = await screen.findByRole("alert");
		expect(band.textContent).toContain(ev.loadFailed);
		expect(rows()).toHaveLength(1);
		list.mockResolvedValueOnce(eventPage([stopped(3)]));
		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.action.retry }),
		);
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(list).toHaveBeenLastCalledWith({ limit: 100, beforeSeq: 9 });
	});

	it("shows placeholder rows while an older page loads", async () => {
		await shown([stopped(9)], { nextBeforeSeq: 9 });
		list.mockReturnValueOnce(new Promise(() => {}));

		await fireEvent.click(screen.getByRole("button", { name: ev.loadOlder }));

		expect(
			screen
				.getByTestId("events-loading-older")
				.querySelector('[data-slot="skeleton"]'),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: ev.loadOlder })).toBeNull();
	});

	it("reads the history and the boots again from the start when stored history is deleted", async () => {
		await shown([stopped(2)]);
		list.mockResolvedValueOnce(eventPage([]));

		notifyHistoryChanged();

		expect(list).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(boots).toHaveBeenCalledTimes(2));
		expect(await screen.findByTestId("events-empty")).toBeTruthy();
	});

	it("marks the rows stale while disconnected and reads them again on reconnect", async () => {
		await shown([stopped(2)]);

		setConnectionState("disconnected");
		const notice = await screen.findByTestId("events-disconnected");
		expect(notice.textContent?.trim()).toBe(
			en.systemLogs.follow.disconnectedBody,
		);
		expect(
			tokens(within(row("stream_stopped")).getByTestId("event-title")),
		).toContain("text-muted-foreground");
		expect(
			tokens(within(row("stream_stopped")).getByTestId("event-title")),
		).not.toContain("text-foreground");

		list.mockResolvedValueOnce(eventPage([stopped(2)]));
		setConnectionState("connected");
		await waitFor(() =>
			expect(screen.queryByTestId("events-disconnected")).toBeNull(),
		);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("owns its scroll below a fixed filter bar, with room under the sticky boot heading", async () => {
		await shown([stopped(1)]);

		const scroller = screen.getByTestId("events-scroller");
		expect(tokens(scroller)).toEqual(
			expect.arrayContaining([
				"min-h-0",
				"flex-1",
				"overflow-y-auto",
				"scroll-pt-16",
			]),
		);
		expect(tokens(scroller.parentElement)).toEqual(
			expect.arrayContaining(["flex", "h-full", "min-h-0", "flex-col"]),
		);
		expect(scroller.contains(screen.getByTestId("events-filters"))).toBe(false);
	});
});

describe("EventsTab — boot heading versions", () => {
	async function heading(
		osImage: string | null,
		slot: string | null,
		withVersions = true,
	): Promise<HTMLElement> {
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				versions: withVersions
					? versions(BOOT_IDS.current, osImage, slot)
					: null,
			}),
		]);
		await shown([stopped(1)]);
		const node = screen.getByRole("heading", { level: 3 });
		await waitFor(() => expect(node.querySelector("time")).toBeTruthy());
		return node;
	}

	it("says the versions were not recorded for a listed boot without them", async () => {
		const node = await heading(null, null, false);
		expect(
			within(node).getByText(en.systemLogs.boots.versionsUnknown),
		).toBeTruthy();
		expect(node.textContent).not.toContain("System image");
	});

	it("shows only the system image when the slot was not recorded", async () => {
		const node = await heading("2026.11.3", null);
		expect(node.textContent).toContain("System image 2026.11.3");
		expect(node.textContent).not.toContain("Slot");
		expect(node.textContent).not.toContain(en.systemLogs.boots.versionsUnknown);
	});

	it("shows only the slot when the system image was not recorded", async () => {
		const node = await heading(null, "a");
		expect(node.textContent).toContain("Slot a");
		expect(node.textContent).not.toContain("System image");
		expect(node.textContent).not.toContain(en.systemLogs.boots.versionsUnknown);
	});
});

describe("EventsTab — right-to-left", () => {
	it("keeps the raw diagnostics left to right inside Arabic chrome", async () => {
		setLocale("ar");
		await shown([
			event(6, "update_refused", { id: "u1", reason: "streaming_active" }),
		]);

		expect(document.documentElement.dir).toBe("rtl");
		const value = within(row("update_refused")).getByText("streaming_active");
		expect(value.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
		expect(value.closest("[dir]")).not.toBe(document.documentElement);
	});
});

describe("EventsTab — layout", () => {
	it("lays a row out as a glyph column and a content column with one wrapping action line", async () => {
		await shown([
			stopped(2, { suppressed: 2 }),
			event(1, "update_refused", { id: "u", reason: "streaming" }),
		]);

		const item = row("stream_stopped");
		has(
			item,
			"grid",
			"grid-cols-[auto_minmax(0,1fr)]",
			"gap-x-3",
			"px-4",
			"py-3",
		);
		const glyph = within(item).getByRole("img", {
			name: en.systemLogs.severity.info,
		});
		has(glyph, "flex", "h-5", "items-center");
		has(glyph.nextElementSibling, "flex", "min-w-0", "flex-col", "gap-1");
		has(
			within(item).getByRole("button", { name: ev.viewRaw }).parentElement,
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-3",
			"gap-y-2",
		);
		has(
			within(item).getByTestId("event-folded"),
			"text-muted-foreground",
			"text-xs",
		);
		const dl = within(row("update_refused"))
			.getByTestId("event-diagnostics-body")
			.querySelector("dl");
		has(dl, "mt-1", "space-y-0.5", "font-mono");
		has(dl?.querySelector("dt"), "inline");
		has(dl?.querySelector("dd"), "inline", "break-all");
	});

	it("wraps a long unbroken value inside its row, keeping all of it isolated", async () => {
		const name = "Yhteysasetustentallennuksenvalmisteluilmoitus".repeat(3);
		await shown([event(1, "capture_source_lost", { name })]);

		const item = row("capture_source_lost");
		expect(
			within(item).getByTestId("event-detail").querySelector("bdi")
				?.textContent,
		).toBe(name);
		has(
			within(item).getByRole("img").nextElementSibling,
			"min-w-0",
			"wrap-anywhere",
		);
	});

	it("breaks Korean between words, Japanese between phrases and balances Chinese lines", async () => {
		await shown([stopped(1)]);

		has(
			screen.getByTestId("events-filters").parentElement,
			"[&:lang(ko)]:break-keep",
			"[&:lang(ja)]:[word-break:auto-phrase]",
			"[&:lang(zh)]:text-balance",
		);
	});

	it("balances a Chinese title and detail over their own pretty wrapping", async () => {
		await shown([stopped(1)]);

		const item = row("stream_stopped");
		has(
			within(item).getByTestId("event-title"),
			"text-pretty",
			"[&:lang(zh)]:text-balance",
		);
		has(
			within(item).getByTestId("event-detail"),
			"text-pretty",
			"[&:lang(zh)]:text-balance",
		);
	});

	it("draws loading rows shaped like event rows", () => {
		list.mockReturnValue(new Promise(() => {}));
		render(EventsTab, { props: { onviewraw: vi.fn() } });

		const first = screen.getByTestId("events-loading").querySelector("div");
		has(first, "flex", "gap-3", "px-4", "py-3");
		const [dot, column] = [...(first?.children ?? [])];
		has(dot, "size-4", "shrink-0", "rounded-full");
		has(column, "flex-1", "space-y-2");
		has(column?.children[0], "h-4", "w-1/2");
		has(column?.children[1], "h-3", "w-3/4");
	});

	it("styles the inline filter bar and its small outline chips", async () => {
		await shown([stopped(1)]);

		has(
			screen.getByTestId("events-filters"),
			"flex",
			"flex-col",
			"gap-3",
			"border-b",
			"px-4",
			"py-3",
		);
		const group = screen.getByRole("group", { name: ev.families });
		has(group, "flex", "flex-wrap", "items-center", "gap-2");
		has(
			group.parentElement,
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-4",
			"gap-y-2",
		);
		for (const chip of [
			...within(group).getAllByRole("button"),
			screen.getByRole("button", { name: ev.problemsOnly }),
		])
			has(chip, "h-7", "border-input");
	});

	it("styles the folded Filter button and its panel", async () => {
		viewport(false);
		await shown([stopped(1)]);

		const toggle = screen.getByTestId("events-filter-toggle");
		has(
			toggle,
			"data-active:bg-muted",
			"gap-1.5",
			"self-start",
			"h-7",
			"border-border",
		);
		has(toggle.querySelector("svg"), "size-4");
		has(
			document.getElementById(toggle.getAttribute("aria-controls") ?? ""),
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-4",
			"gap-y-2",
		);
	});

	it("styles the recovery band's glyph, text and Retry", async () => {
		quietErrors();
		list.mockRejectedValueOnce(new Error("down"));
		render(EventsTab, { props: { onviewraw: vi.fn() } });

		const band = await screen.findByRole("alert");
		has(band.querySelector("svg"), "text-status-warning", "size-4", "shrink-0");
		has(within(band).getByText(ev.loadFailed), "min-w-0", "flex-1", "text-sm");
		const retry = within(band).getByRole("button", {
			name: en.systemLogs.action.retry,
		});
		has(retry, "shrink-0", "gap-1.5", "h-7", "border-border");
		has(retry.querySelector("svg"), "size-4");
	});

	it("shows no disconnected notice while connected, and styles it once disconnected", async () => {
		await shown([stopped(2)]);
		expect(screen.queryByTestId("events-disconnected")).toBeNull();

		setConnectionState("disconnected");

		const notice = await screen.findByTestId("events-disconnected");
		has(
			notice,
			"text-muted-foreground",
			"flex",
			"items-start",
			"gap-2",
			"border-b",
			"px-4",
			"py-2",
			"text-sm",
		);
		has(notice.querySelector("svg"), "mt-0.5", "size-4", "shrink-0");
	});

	it("styles the empty state", async () => {
		await shown([]);

		const empty = screen.getByTestId("events-empty");
		has(
			empty,
			"flex",
			"flex-col",
			"items-center",
			"gap-2",
			"px-6",
			"py-10",
			"text-center",
		);
		has(within(empty).getByText(ev.emptyTitle), "text-sm", "font-semibold");
		has(
			within(empty).getByText(ev.emptyBody),
			"text-muted-foreground",
			"max-w-prose",
			"text-sm",
		);
	});

	it("styles the filtered empty state and its Show all events action", async () => {
		const [, clean] = fourBoots();
		bootSelection.choose(clean ?? null);
		await shown([]);

		const empty = screen.getByTestId("events-empty");
		has(within(empty).getByText(ev.emptyFiltered), "text-sm", "font-semibold");
		has(
			within(empty).getByRole("button", { name: ev.showAll }),
			"mt-2",
			"h-7",
			"border-border",
		);
	});

	it("styles the boot heading's start, versions and Changed tag", async () => {
		const [current, clean] = fourBoots();
		boots.mockResolvedValue([
			boot(BOOT_IDS.current, "current", {
				...current,
				versions: versions(BOOT_IDS.current, "2026.11.3-beta", "b"),
			}),
			boot(BOOT_IDS.clean, "clean", {
				...clean,
				versions: versions(BOOT_IDS.clean, "2026.11.2", "a"),
			}),
		]);
		await shown([stopped(1)]);

		const node = screen.getByRole("heading", { level: 3 });
		await waitFor(() => expect(node.querySelector("time")).toBeTruthy());
		const time = node.querySelector("time");
		has(time, "text-sm", "font-medium", "tabular-nums");
		has(
			time?.nextElementSibling,
			"text-muted-foreground",
			"flex",
			"flex-wrap",
			"gap-x-2",
		);
		has(
			within(node).getByText(en.systemLogs.boots.changed),
			"bg-secondary",
			"text-secondary-foreground",
			"rounded-sm",
			"px-1.5",
			"py-0.5",
			"font-medium",
		);
	});

	it("styles the heading when the boot list failed, is loading, or lacks the boot", async () => {
		quietErrors();
		boots.mockRejectedValueOnce(new Error("down"));
		await shown([stopped(1)]);
		const failed = screen.getByRole("heading", { level: 3 });
		await waitFor(() =>
			expect(failed.textContent?.trim()).toBe(en.systemLogs.boots.loadFailed),
		);
		has(failed.firstElementChild, "text-sm", "font-medium");
		cleanup();

		boots.mockReturnValueOnce(new Promise(() => {}));
		await shown([stopped(1)]);
		const loading = screen.getByRole("heading", { level: 3 });
		has(within(loading).getByText(en.common.loading), "sr-only");
		has(loading.querySelector('[data-slot="skeleton"]'), "h-4", "w-48");
		cleanup();

		boots.mockResolvedValueOnce([]);
		await shown([stopped(1, { bootId: "e".repeat(32) })]);
		const missing = screen.getByRole("heading", { level: 3 });
		await waitFor(() =>
			expect(missing.textContent?.trim()).toBe(
				en.systemLogs.boots.versionsUnknown,
			),
		);
		has(missing.firstElementChild, "text-sm", "font-medium");
	});

	it("separates rows with neutral rules and draws the clock marker between them", async () => {
		await shown([
			stopped(2, { at: EVENT_AT }),
			stopped(1, { at: EVENT_AT + 60_000 }),
		]);

		has(rows()[0]?.parentElement, "divide-y");
		has(
			screen.getByTestId("events-clock"),
			"text-muted-foreground",
			"before:bg-border",
			"after:bg-border",
			"flex",
			"items-center",
			"gap-3",
			"px-4",
			"py-2",
			"text-xs",
			"before:h-px",
			"before:flex-1",
			"after:h-px",
			"after:flex-1",
		);
	});

	it("centres a small outline Load older", async () => {
		await shown([stopped(9)], { nextBeforeSeq: 9 });

		const older = screen.getByRole("button", { name: ev.loadOlder });
		has(older, "h-7", "border-border");
		has(older.parentElement, "flex", "justify-center", "px-4", "py-3");
	});

	it("draws the end of the stored history between neutral rules", async () => {
		await shown([stopped(1)]);

		has(
			screen.getByTestId("events-end"),
			"text-muted-foreground",
			"before:bg-border",
			"after:bg-border",
			"flex",
			"items-center",
			"gap-3",
			"px-4",
			"py-3",
			"text-xs",
			"before:h-px",
			"before:flex-1",
			"after:h-px",
			"after:flex-1",
		);
	});
});

describe("EventsTab: keyboard", () => {
	// Contract section 7: the list is one tab stop; Up and Down move between rows,
	// Home and End jump, and Tab reaches the focused row's own actions. A row's
	// stop is its first action, View raw logs.
	const viewRaw = (scope: HTMLElement) =>
		within(scope).getByRole("button", { name: ev.viewRaw });
	const diagnostics = (scope: HTMLElement) =>
		within(scope).getByTestId("event-diagnostics-toggle");
	const refused = (seq: number) =>
		event(seq, "update_refused", { id: "u1", reason: "streaming_active" });
	const tabIndexes = (all: HTMLElement[]) =>
		all.map((element) =>
			[...element.querySelectorAll("button")].map((button) => button.tabIndex),
		);
	const press = (key: string) =>
		fireEvent.keyDown(document.activeElement as HTMLElement, { key });

	it("moves focus between rows with the arrow keys, Home and End", async () => {
		await shown([stopped(4), refused(3), stopped(2), stopped(1)]);
		const all = rows() as HTMLElement[];
		viewRaw(all[0] as HTMLElement).focus();

		// The list takes the key, so the scroller does not also scroll.
		expect(await press("ArrowDown")).toBe(false);
		expect(document.activeElement).toBe(viewRaw(all[1] as HTMLElement));
		diagnostics(all[1] as HTMLElement).focus();
		await press("ArrowDown");
		expect(document.activeElement).toBe(viewRaw(all[2] as HTMLElement));
		await press("End");
		expect(document.activeElement).toBe(viewRaw(all[3] as HTMLElement));
		await press("ArrowDown");
		expect(document.activeElement).toBe(viewRaw(all[3] as HTMLElement));
		await press("ArrowUp");
		expect(document.activeElement).toBe(viewRaw(all[2] as HTMLElement));
		await press("Home");
		expect(document.activeElement).toBe(viewRaw(all[0] as HTMLElement));
		await press("ArrowUp");
		expect(document.activeElement).toBe(viewRaw(all[0] as HTMLElement));
		// Other keys keep their meaning: Enter still activates the action.
		expect(await press("Enter")).toBe(true);
	});

	it("keeps only the focused row's actions in the tab sequence", async () => {
		await shown([stopped(3), refused(2), stopped(1)]);
		const all = rows() as HTMLElement[];
		expect(tabIndexes(all)).toEqual([[0], [-1, -1], [-1]]);

		viewRaw(all[0] as HTMLElement).focus();
		await press("ArrowDown");
		await tick();
		expect(tabIndexes(all)).toEqual([[-1], [0, 0], [-1]]);

		// A pointer can focus any row's action; that row becomes the stop.
		viewRaw(all[2] as HTMLElement).focus();
		await fireEvent.focusIn(viewRaw(all[2] as HTMLElement));
		await tick();
		expect(tabIndexes(all)).toEqual([[-1], [-1, -1], [0]]);
	});

	it("keeps a pending row's View raw logs focusable, so the keys still cross it", async () => {
		await shown([stopped(3), stopped(2), stopped(1)]);
		const held = Promise.withResolvers<LogAroundOutput>();
		around.mockReturnValueOnce(held.promise);
		const all = rows() as HTMLElement[];
		const pending = viewRaw(all[1] as HTMLElement);
		pending.focus();
		await fireEvent.click(pending);
		await tick();
		expect(document.activeElement).toBe(pending);

		await press("ArrowDown");
		expect(document.activeElement).toBe(viewRaw(all[2] as HTMLElement));
		await press("ArrowUp");
		expect(document.activeElement).toBe(pending);
		await press("ArrowUp");
		expect(document.activeElement).toBe(viewRaw(all[0] as HTMLElement));
		await press("ArrowDown");
		expect(document.activeElement).toBe(pending);
		await press("End");
		expect(document.activeElement).toBe(viewRaw(all[2] as HTMLElement));
		await press("Home");
		await press("ArrowDown");
		expect(document.activeElement).toBe(pending);

		// The reply settles as a failure: focus and the stop stay on the row.
		held.resolve({ ok: false, error: "BUSY" });
		await within(all[1] as HTMLElement).findByTestId("event-raw-note");
		expect(document.activeElement).toBe(pending);
		expect(pending.hasAttribute("aria-disabled")).toBe(false);
		expect(tabIndexes(all)).toEqual([[-1], [0], [-1]]);
		await press("ArrowDown");
		expect(document.activeElement).toBe(viewRaw(all[2] as HTMLElement));
		// Settled, the action works again: a retry asks once more.
		around.mockReturnValueOnce(new Promise(() => {}));
		await fireEvent.click(pending);
		expect(around).toHaveBeenCalledTimes(2);
	});

	it("keeps focus and the stop on a row when a newer event of its boot arrives", async () => {
		await shown([stopped(3), stopped(2), stopped(1)]);
		const held = viewRaw(rows()[1] as HTMLElement);
		held.focus();
		await fireEvent.focusIn(held);

		feed.listener?.([stopped(4)]);
		await tick();
		expect(rows()).toHaveLength(4);
		expect(document.activeElement).toBe(held);
		expect(tabIndexes(rows())).toEqual([[-1], [-1], [0], [-1]]);
		await press("ArrowUp");
		expect(document.activeElement).toBe(viewRaw(rows()[1] as HTMLElement));
	});
});
