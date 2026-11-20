// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type {
	LogAroundOutput,
	LogEntry,
	LogFollowMessage,
	LogQueryOutput,
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
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	resetConnectionState,
	setConnectionState,
	setSocketAuthenticated,
} from "$lib/components/custom/__fixtures__/connection-state.svelte";
import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";
import { RawView } from "$lib/device-logs/raw-view.svelte";

import { en } from "../../tests/helpers/catalog";
import BootPicker from "./BootPicker.svelte";
import RawLogsFilterBar from "./RawLogsFilterBar.svelte";
import RawLogsTab from "./RawLogsTab.svelte";

const logs = vi.hoisted(() => ({
	boots: vi.fn(),
	query: vi.fn(),
	followStart: vi.fn(),
	followStop: vi.fn(),
}));
const follow = vi.hoisted(() => ({
	listener: undefined as ((message: LogFollowMessage) => void) | undefined,
}));

vi.mock("$lib/rpc/client", () => ({ rpc: { logs } }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: (
		listener: ((message: LogFollowMessage) => void) | undefined,
	) => {
		follow.listener = listener;
	},
}));
vi.mock("$lib/helpers/clipboard", () => ({ copyToClipboard: vi.fn() }));

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const DEFAULT_INPUT = {
	sources: [],
	levels: ["error", "warning", "info"],
	boot: "current",
	direction: "older",
	limit: 100,
};
type QueryPage = Extract<LogQueryOutput, { ok: true }>;
type AroundPage = Extract<LogAroundOutput, { ok: true }>;

function entry(cursor: string, patch: Partial<LogEntry> = {}): LogEntry {
	return {
		cursor,
		ts: Date.UTC(2026, 10, 15, 12, 0, 0),
		bootId: BOOT,
		level: "info",
		source: "app",
		unit: "ceralive.service",
		message: `message ${cursor}`,
		truncated: false,
		marker: null,
		...patch,
	};
}

function page(
	cursors: readonly string[],
	patch: Partial<QueryPage> = {},
): QueryPage {
	return {
		ok: true,
		entries: cursors.map((cursor) => entry(cursor)),
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId: BOOT,
		...patch,
	};
}

function push(message: Partial<LogFollowMessage>): void {
	follow.listener?.({
		subscriptionId: "sub-1",
		entries: [],
		checkpointCursor: null,
		dropped: 0,
		...message,
	});
}

const cursors = () =>
	screen.queryAllByTestId("raw-row").map((row) => row.dataset.cursor);

function has(element: Element | null | undefined, ...tokens: string[]): void {
	const classes = (element?.getAttribute("class") ?? "").split(/\s+/);
	for (const token of tokens) expect(classes, token).toContain(token);
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
let scrollerHeight = 4000;

beforeAll(() => {
	// jsdom lays nothing out; give the list a viewport so the virtualizer renders rows.
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-raw-scroller") ? scrollerHeight : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-index") ? 36 : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-raw-scroller") ? 1000 : 0;
		},
	});
	// The virtualizer clamps every scroll command to scrollHeight - clientHeight.
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (!this.hasAttribute("data-raw-scroller")) return 0;
			const list = this.querySelector<HTMLElement>('[data-testid="raw-list"]');
			return Math.max(
				Number.parseFloat(list?.style.height ?? "") || 0,
				scrollerHeight,
			);
		},
	});
	const element = Element.prototype as unknown as Record<string, unknown>;
	element.hasPointerCapture ??= () => false;
	element.setPointerCapture ??= () => {};
	element.releasePointerCapture ??= () => {};
	Element.prototype.scrollIntoView ??= () => {};
	// The virtualizer scrolls through scrollTo and waits for the scroll event a browser fires.
	element.scrollTo ??= function (this: HTMLElement, options: ScrollToOptions) {
		this.scrollTop = options.top ?? this.scrollTop;
		this.dispatchEvent(new Event("scroll"));
	};
});

afterAll(() => {
	delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
	delete proto.clientHeight;
	delete proto.offsetHeight;
	delete proto.clientWidth;
	delete proto.scrollHeight;
});

beforeEach(() => {
	scrollerHeight = 4000;
	logs.boots.mockReset();
	logs.boots.mockResolvedValue([]);
	logs.query.mockReset();
	logs.followStart.mockReset();
	logs.followStop.mockReset();
	logs.followStop.mockResolvedValue({ success: true, checkpointCursor: null });
	follow.listener = undefined;
	resetConnectionState();
});

afterEach(() => {
	cleanup();
	bootSelection.reset();
	vi.restoreAllMocks();
});

it("reads the selected boot on mount and follows later picker choices", async () => {
	const boots = fourBoots();
	const first = boots[1];
	const next = boots[2];
	if (!first || !next) throw new Error("boot fixtures missing");
	bootSelection.choose(first);
	logs.query.mockResolvedValue(page([]));
	render(RawLogsTab);

	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			boot: first.bootId,
		}),
	);
	bootSelection.choose(next);
	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			boot: next.bootId,
		}),
	);
	bootSelection.choose(null);
	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			boot: "all",
		}),
	);
	cleanup();
	const reads = logs.query.mock.calls.length;
	bootSelection.choose(first);
	await tick();
	expect(logs.query).toHaveBeenCalledTimes(reads);
});

async function mounted(
	first: QueryPage = page(["s=3", "s=2", "s=1"]),
	around?: AroundPage,
) {
	if (around) return render(RawLogsTab, { around });
	logs.query.mockResolvedValueOnce(first);
	const view = render(RawLogsTab);
	await waitFor(() => expect(screen.queryByTestId("raw-loading")).toBeNull());
	return view;
}

it("selects Running now for This boot and lets All boots change the Raw scope", async () => {
	const running = fourBoots().find(({ current }) => current);
	if (!running) throw new Error("missing running boot");
	logs.boots.mockResolvedValue([running]);
	logs.query.mockResolvedValue(page(["s=1"]));
	render(RawLogsTab);
	render(BootPicker);

	const current = await screen.findByRole("option", { name: /Running now/ });
	const all = screen.getByRole("option", { name: en.systemLogs.boots.all });
	expect(current.getAttribute("aria-selected")).toBe("true");
	expect(all.getAttribute("aria-selected")).toBe("false");
	await fireEvent.click(all);
	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			boot: "all",
		}),
	);
	expect(all.getAttribute("aria-selected")).toBe("true");

	await fireEvent.click(current);
	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT),
	);
	expect(current.getAttribute("aria-selected")).toBe("true");
	expect(screen.getByTestId("raw-follow-button").hasAttribute("disabled")).toBe(
		false,
	);
});

async function startFollowing() {
	logs.followStart.mockResolvedValueOnce({
		ok: true,
		subscriptionId: "sub-1",
		checkpointCursor: "s=3",
	});
	await fireEvent.click(screen.getByTestId("raw-follow-button"));
	await screen.findByText(en.systemLogs.follow.following);
}

it("keeps live rows when a mounted Raw tab takes Follow back before its old filter reply", async () => {
	logs.query.mockResolvedValue(page(["initial"]));
	const first = within(render(RawLogsTab).container);
	const second = within(render(RawLogsTab).container);
	await first.findByText("message initial");
	await second.findByText("message initial");
	const firstButton = first.getByTestId("raw-follow-button");
	const secondButton = second.getByTestId("raw-follow-button");
	const checkpointCursor = `boot-start:${BOOT}:0`;
	logs.followStart
		.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor,
		})
		.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor,
		})
		.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-3",
			checkpointCursor,
		});
	await fireEvent.click(firstButton);
	await first.findByText(en.systemLogs.follow.following);

	const reply = Promise.withResolvers<QueryPage>();
	logs.query.mockReturnValueOnce(reply.promise);
	await fireEvent.click(
		first.getByRole("radio", { name: en.systemLogs.raw.levelEverything }),
	);
	expect(firstButton.getAttribute("aria-disabled")).toBe("true");
	await fireEvent.click(secondButton);
	await first.findByText(en.systemLogs.follow.stopped);
	await second.findByText(en.systemLogs.follow.following);
	const status = first.getByTestId("raw-status");
	expect(status.getAttribute("role")).toBe("status");
	expect(status.getAttribute("aria-live")).toBe("polite");
	expect(status.textContent).toBe(en.systemLogs.announce.stopped);
	expect(firstButton.hasAttribute("aria-disabled")).toBe(false);

	await fireEvent.click(firstButton);
	await first.findByText(en.systemLogs.follow.following);
	await second.findByText(en.systemLogs.follow.stopped);
	push({
		subscriptionId: "sub-3",
		entries: [entry("fresh-after-retake")],
		checkpointCursor: "fresh-after-retake",
	});
	await first.findByText("message fresh-after-retake");
	expect(second.queryByText("message fresh-after-retake")).toBeNull();

	reply.resolve(page(["old-filter-snapshot"]));
	// Cross the RPC promise and Svelte's render work before checking the visible rows.
	await reply.promise;
	await tick();
	await tick();

	expect(first.getByTestId("raw-follow-state").textContent?.trim()).toBe(
		en.systemLogs.follow.following,
	);
	expect(
		first.queryAllByTestId("raw-row").map((row) => row.dataset.cursor),
	).toEqual(["fresh-after-retake"]);
	expect(first.queryByTestId("raw-loading")).toBeNull();
});

describe("RawLogsTab: first page", () => {
	it("asks for the default view and lists its entries", async () => {
		await mounted();
		expect(logs.query).toHaveBeenCalledExactlyOnceWith(DEFAULT_INPUT);
		expect(cursors()).toEqual(["s=3", "s=2", "s=1"]);
		expect(screen.getByTestId("raw-list").tagName).toBe("UL");
		expect(screen.getByTestId("raw-list").getAttribute("aria-live")).toBeNull();
		expect(screen.queryByTestId("raw-top")).toBeNull();
	});

	it("shows skeleton rows and a hidden loading status while the first page loads", () => {
		logs.query.mockReturnValueOnce(new Promise(() => {}));
		render(RawLogsTab);
		const loading = screen.getByTestId("raw-loading");
		expect(
			within(loading).getByText(en.systemLogs.loading.entries).className,
		).toContain("sr-only");
		expect(loading.getAttribute("role")).toBe("status");
		expect(
			loading.querySelectorAll('[data-slot="skeleton"]').length,
		).toBeGreaterThan(5);
		expect(screen.queryByTestId("raw-empty")).toBeNull();
	});

	it("mounts one polite status region before any follow starts", async () => {
		await mounted();
		const status = screen.getByTestId("raw-status");
		expect(status.getAttribute("role")).toBe("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.className).toContain("sr-only");
		expect(status.textContent).toBe("");
	});

	it("starts every mount with a fresh first query", async () => {
		const first = await mounted();
		first.unmount();
		await mounted(page(["n=1"]));
		expect(logs.query).toHaveBeenCalledTimes(2);
		expect(logs.query.mock.calls[1]?.[0]).toEqual(DEFAULT_INPUT);
		expect(cursors()).toEqual(["n=1"]);
	});

	it("teaches the filter when nothing matches and resets on Show everything", async () => {
		await mounted(page([]));
		const empty = screen.getByTestId("raw-empty");
		expect(within(empty).getByText(en.systemLogs.raw.emptyTitle)).toBeTruthy();
		expect(within(empty).getByText(en.systemLogs.raw.emptyHint)).toBeTruthy();
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			screen.getByRole("radio", { name: en.systemLogs.raw.levelErrors }),
		);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			within(screen.getByTestId("raw-empty")).getByRole("button", {
				name: en.systemLogs.raw.resetFilters,
			}),
		);
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(screen.queryByTestId("raw-end-bottom")).toBeNull();
	});
});

describe("RawLogsTab: filters", () => {
	it.each([
		{ label: en.systemLogs.raw.levelErrors, levels: ["error"] },
		{ label: en.systemLogs.raw.levelWarnings, levels: ["error", "warning"] },
		{
			label: en.systemLogs.raw.levelEverything,
			levels: ["error", "warning", "info", "debug"],
		},
	])(
		"re-queries with the level set selected by $label",
		async ({ label, levels }) => {
			await mounted();
			const group = screen.getByRole("radiogroup", {
				name: en.systemLogs.raw.levelLabel,
			});
			expect(
				within(group)
					.getAllByRole("radio")
					.map((node) => node.textContent?.trim()),
			).toEqual([
				en.systemLogs.raw.levelErrors,
				en.systemLogs.raw.levelWarnings,
				en.systemLogs.raw.levelInfo,
				en.systemLogs.raw.levelEverything,
			]);
			expect(
				within(group).getByRole("radio", { checked: true }).textContent?.trim(),
			).toBe(en.systemLogs.raw.levelInfo);
			logs.query.mockResolvedValueOnce(page(["e=1"]));
			await fireEvent.click(within(group).getByRole("radio", { name: label }));
			expect(logs.query).toHaveBeenLastCalledWith({
				...DEFAULT_INPUT,
				levels,
			});
			await waitFor(() => expect(cursors()).toEqual(["e=1"]));
			expect(
				within(group).getByRole("radio", { checked: true }).textContent?.trim(),
			).toBe(label);
		},
	);

	it("searches on Enter and clears the search", async () => {
		await mounted();
		const search = screen.getByRole("textbox", {
			name: en.systemLogs.raw.searchLabel,
		});
		expect(search.getAttribute("placeholder")).toBe(
			en.systemLogs.raw.searchLabel,
		);
		expect(search.parentElement?.className).toContain("min-w-32");
		expect(search.parentElement?.className).toContain("flex-1");
		expect(
			screen.queryByRole("button", { name: en.systemLogs.raw.searchClear }),
		).toBeNull();
		logs.query.mockResolvedValue(page([]));
		await fireEvent.input(search, { target: { value: "srt" } });
		await fireEvent.keyDown(search, { key: "Enter" });
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			text: "srt",
		});
		const clear = screen.getByRole("button", {
			name: en.systemLogs.raw.searchClear,
		});
		expect(clear.dataset.touchTarget).toBe("hit-area");
		await fireEvent.click(clear);
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect((search as HTMLInputElement).value).toBe("");
	});

	it("shortens the search placeholder while the filters are folded and keeps the full name", async () => {
		// The Filters button renders only while the bar folds its filters; browsers report its size through ResizeObserver.
		let report: ((width: number) => void) | undefined;
		class FoldObserver {
			readonly #callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.#callback = callback;
			}
			observe(target: Element): void {
				if (target !== screen.queryByTestId("raw-filters-toggle")) return;
				report = (width) =>
					this.#callback(
						[
							{
								target,
								borderBoxSize: [],
								contentBoxSize: [],
								devicePixelContentBoxSize: [],
								contentRect: new DOMRect(0, 0, width, 32),
							},
						],
						this,
					);
			}
			unobserve(): void {}
			disconnect(): void {}
		}
		const view = document.defaultView as unknown as Record<string, unknown>;
		view.ResizeObserver = FoldObserver;
		try {
			await mounted();
			const search = screen.getByRole("textbox", {
				name: en.systemLogs.raw.searchLabel,
			});
			expect(search.getAttribute("placeholder")).toBe(
				en.systemLogs.raw.searchLabel,
			);

			report?.(96);
			await tick();
			expect(search.getAttribute("placeholder")).toBe(
				en.systemLogs.raw.searchShort,
			);
			expect(search.getAttribute("aria-label")).toBe(
				en.systemLogs.raw.searchLabel,
			);

			report?.(0);
			await tick();
			expect(search.getAttribute("placeholder")).toBe(
				en.systemLogs.raw.searchLabel,
			);
		} finally {
			delete view.ResizeObserver;
		}
	});

	it("ignores keys other than Enter in the search box", async () => {
		await mounted();
		const search = screen.getByRole("textbox", {
			name: en.systemLogs.raw.searchLabel,
		});
		await fireEvent.input(search, { target: { value: "x" } });
		await fireEvent.keyDown(search, { key: "a" });
		expect(logs.query).toHaveBeenCalledTimes(1);
	});

	it("shows All sources in the value colour and lines the folded filters' labels up along their top", async () => {
		await mounted();
		const sources = screen.getByTestId("raw-sources");
		expect(sources.textContent?.trim()).toBe(en.systemLogs.raw.sourceAll);
		has(sources, "data-placeholder:text-foreground");
		has(screen.getByTestId("raw-filters-panel"), "items-start");
	});

	it("folds Source, Time and Order behind Filters and counts the changed ones", async () => {
		await mounted();
		const toggle = screen.getByTestId("raw-filters-toggle");
		const panel = screen.getByTestId("raw-filters-panel");
		expect(toggle.textContent?.trim()).toBe(en.systemLogs.raw.filters);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
		expect(panel.dataset.open).toBe("false");
		expect(panel.className).toContain("hidden");
		expect(toggle.className).toContain(
			"@min-[45rem]:[@media(min-height:601px)]:hidden",
		);
		expect(panel.className).toContain(
			"@min-[45rem]:[@media(min-height:601px)]:flex",
		);
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel.dataset.open).toBe("true");
		has(panel, "flex");
		expect(panel.className).not.toMatch(/(^| )hidden( |$)/);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			screen.getByRole("radio", { name: en.systemLogs.raw.orderOldest }),
		);
		expect(toggle.textContent?.trim()).toBe(
			en.systemLogs.raw.filtersActive.replace("{count}", "1"),
		);
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	it("reads oldest first when Oldest first is chosen", async () => {
		await mounted();
		const order = screen.getByRole("radiogroup", {
			name: en.systemLogs.raw.orderLabel,
		});
		expect(
			within(order).getByRole("radio", { checked: true }).textContent?.trim(),
		).toBe(en.systemLogs.raw.orderNewest);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			within(order).getByRole("radio", { name: en.systemLogs.raw.orderOldest }),
		);
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			direction: "newer",
		});
		expect(
			within(order).getByRole("radio", { checked: true }).textContent?.trim(),
		).toBe(en.systemLogs.raw.orderOldest);
	});

	it("filters by source from the Sources select", async () => {
		await mounted();
		const trigger = screen.getByTestId("raw-sources");
		expect(trigger.textContent?.trim()).toBe(en.systemLogs.raw.sourceAll);
		expect(trigger.getAttribute("aria-labelledby")).toBe(
			screen.getByText(en.systemLogs.raw.sourceLabel).id,
		);
		await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
		await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
		const option = await screen.findByTestId("raw-source-option-engine");
		expect(option.textContent?.trim()).toBe(en.systemLogs.source.engine);
		expect(
			document.querySelectorAll('[data-testid^="raw-source-option-"]'),
		).toHaveLength(8);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
		await waitFor(() =>
			expect(logs.query).toHaveBeenLastCalledWith({
				...DEFAULT_INPUT,
				sources: ["engine"],
			}),
		);
		expect(trigger.textContent?.trim()).toBe(
			en.systemLogs.raw.sourceCount.replace("{count}", "1"),
		);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.pointerUp(
			await screen.findByTestId("raw-source-option-network"),
			{ pointerType: "mouse", button: 0 },
		);
		await waitFor(() =>
			expect(logs.query).toHaveBeenLastCalledWith({
				...DEFAULT_INPUT,
				sources: ["engine", "network"],
			}),
		);
		expect(trigger.textContent?.trim()).toBe(
			en.systemLogs.raw.sourceCount.replace("{count}", "2"),
		);
	});

	it("forgets chosen sources after Show everything resets the filter", async () => {
		await mounted();
		const open = async () => {
			const trigger = screen.getByTestId("raw-sources");
			await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
			await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
		};
		await open();
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.pointerUp(
			await screen.findByTestId("raw-source-option-engine"),
			{ pointerType: "mouse", button: 0 },
		);
		await fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		logs.query.mockResolvedValueOnce(page(["s=1"]));
		await fireEvent.click(await screen.findByTestId("raw-reset-filters"));
		await waitFor(() => expect(cursors()).toEqual(["s=1"]));
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		await open();
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.pointerUp(
			await screen.findByTestId("raw-source-option-network"),
			{ pointerType: "mouse", button: 0 },
		);
		await waitFor(() =>
			expect(logs.query).toHaveBeenLastCalledWith({
				...DEFAULT_INPUT,
				sources: ["network"],
			}),
		);
	});

	it.each([
		{ value: "15m", label: en.systemLogs.raw.timeLast15m, span: 15 * 60_000 },
		{ value: "1h", label: en.systemLogs.raw.timeLastHour, span: 60 * 60_000 },
		{
			value: "24h",
			label: en.systemLogs.raw.timeLast24h,
			span: 24 * 60 * 60_000,
		},
		{ value: "all", label: en.systemLogs.raw.timeAll, span: null },
	])(
		"reads $label over every boot from the Time select",
		async ({ value, label, span }) => {
			const now = 1_800_000_000_000;
			vi.spyOn(Date, "now").mockReturnValue(now);
			await mounted();
			const trigger = screen.getByTestId("raw-time");
			expect(trigger.textContent?.trim()).toBe(en.systemLogs.raw.timeThisBoot);
			expect(trigger.getAttribute("aria-labelledby")).toBe(
				screen.getByText(en.systemLogs.raw.timeLabel).id,
			);
			await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
			await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
			const labels = [
				...document.querySelectorAll('[data-testid^="raw-time-option-"]'),
			].map((node) => node.textContent?.trim());
			expect(labels).toEqual([
				en.systemLogs.raw.timeThisBoot,
				en.systemLogs.raw.timeLast15m,
				en.systemLogs.raw.timeLastHour,
				en.systemLogs.raw.timeLast24h,
				en.systemLogs.raw.timeAll,
			]);
			logs.query.mockResolvedValueOnce(page([]));
			await fireEvent.pointerUp(
				screen.getByTestId(`raw-time-option-${value}`),
				{
					pointerType: "mouse",
					button: 0,
				},
			);
			await waitFor(() =>
				expect(logs.query).toHaveBeenLastCalledWith({
					...DEFAULT_INPUT,
					boot: "all",
					...(span === null ? {} : { since: now - span }),
				}),
			);
			expect(trigger.textContent?.trim()).toBe(label);
		},
	);

	it("shows a chosen boot in Time and leaves it when a time window is selected", async () => {
		const now = 1_800_000_000_000;
		logs.query.mockResolvedValue(page([]));
		const view = new RawView({
			logs,
			setFollowListener: () => {},
			now: () => now,
		});
		try {
			await view.chooseBoot(BOOT);
			render(RawLogsFilterBar, { view });
			const trigger = screen.getByTestId("raw-time");
			expect(trigger.textContent?.trim()).toBe(en.systemLogs.raw.timeBoot);
			await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
			await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
			const selected = await screen.findByTestId("raw-time-option-boot");
			expect(selected.textContent?.trim()).toBe(en.systemLogs.raw.timeBoot);
			expect(selected.getAttribute("aria-selected")).toBe("true");
			expect(logs.query).toHaveBeenCalledExactlyOnceWith({
				...DEFAULT_INPUT,
				boot: BOOT,
			});
			await fireEvent.pointerUp(selected, { pointerType: "mouse", button: 0 });
			expect(logs.query).toHaveBeenCalledTimes(1);
			await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
			await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
			await fireEvent.pointerUp(screen.getByTestId("raw-time-option-15m"), {
				pointerType: "mouse",
				button: 0,
			});
			await waitFor(() =>
				expect(logs.query).toHaveBeenLastCalledWith({
					...DEFAULT_INPUT,
					boot: "all",
					since: now - 15 * 60_000,
				}),
			);
			expect(view.filter.bootId).toBeNull();
			expect(trigger.textContent?.trim()).toBe(en.systemLogs.raw.timeLast15m);
		} finally {
			view.dispose();
		}
	});
});

describe("RawLogsTab: paging", () => {
	it("passes the previous continuation on Load more", async () => {
		await mounted(page(["s=3", "s=2"], { hasMore: true, continuation: "c1" }));
		logs.query.mockResolvedValueOnce(page(["s=1"]));
		const more = screen.getByTestId("raw-load-more-bottom");
		expect(more.textContent?.trim()).toBe(en.systemLogs.raw.loadMore);
		await fireEvent.click(more);
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "c1",
		});
		await waitFor(() => expect(cursors()).toEqual(["s=3", "s=2", "s=1"]));
		expect(screen.getByTestId("raw-end-bottom").textContent?.trim()).toBe(
			en.systemLogs.raw.end,
		);
	});

	it("shows Keep searching and no end marker for a partial scan", async () => {
		await mounted(
			page(["s=1"], {
				hasMore: null,
				termination: "budget",
				continuation: "c1",
			}),
		);
		expect(screen.queryByTestId("raw-end-bottom")).toBeNull();
		expect(screen.queryByTestId("raw-empty")).toBeNull();
		expect(screen.getByText(en.systemLogs.raw.keepSearchingHint)).toBeTruthy();
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			screen.getByRole("button", { name: en.systemLogs.raw.keepSearching }),
		);
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "c1",
		});
	});

	it("keeps searching even when the partial scan matched nothing yet", async () => {
		await mounted(
			page([], { hasMore: null, termination: "budget", continuation: "c1" }),
		);
		expect(screen.queryByTestId("raw-empty")).toBeNull();
		expect(
			screen.getByRole("button", { name: en.systemLogs.raw.keepSearching }),
		).toBeTruthy();
	});

	it("repeats the first query from Keep searching after a budget page with no position", async () => {
		await mounted(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		logs.query.mockResolvedValueOnce(page(["s=1"]));
		await fireEvent.click(
			screen.getByRole("button", { name: en.systemLogs.raw.keepSearching }),
		);
		await waitFor(() => expect(cursors()).toEqual(["s=1"]));
		expect(logs.query).toHaveBeenCalledTimes(2);
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(screen.getByTestId("raw-end-bottom")).toBeTruthy();
	});

	it("shows skeleton rows below the list while the next page loads, and Load more keeps focus, busy and unavailable", async () => {
		await mounted(page(["s=2"], { hasMore: true, continuation: "c1" }));
		logs.query.mockReturnValueOnce(new Promise(() => {}));
		const more = screen.getByTestId("raw-load-more-bottom");
		more.focus();
		await fireEvent.click(more);
		expect(
			screen
				.getByTestId("raw-loading-bottom")
				.querySelectorAll('[data-slot="skeleton"]').length,
		).toBeGreaterThan(0);
		expect(document.activeElement).toBe(more);
		expect(more.getAttribute("aria-disabled")).toBe("true");
		expect(more.getAttribute("aria-busy")).toBe("true");
		has(more, "aria-disabled:pointer-events-none", "aria-disabled:opacity-50");
		await fireEvent.click(more);
		expect(logs.query).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("raw-end-bottom")).toBeNull();
	});

	it("keeps Keep searching focused, busy and unavailable while it reads on", async () => {
		await mounted(page(["s=2"], { hasMore: null, continuation: "c1" }));
		logs.query.mockReturnValueOnce(new Promise(() => {}));
		const keep = screen.getByTestId("raw-keep-searching-bottom");
		keep.focus();
		await fireEvent.click(keep);
		expect(screen.getByTestId("raw-loading-bottom")).toBeTruthy();
		expect(document.activeElement).toBe(keep);
		expect(keep.getAttribute("aria-disabled")).toBe("true");
		expect(keep.getAttribute("aria-busy")).toBe("true");
		has(keep, "aria-disabled:pointer-events-none", "aria-disabled:opacity-50");
		await fireEvent.click(keep);
		expect(logs.query).toHaveBeenCalledTimes(2);
	});

	it("hands focus to the row stop when the page that lands replaces Load more with the end", async () => {
		await mounted(page(["s=2"], { hasMore: true, continuation: "c1" }));
		const next = Promise.withResolvers<QueryPage>();
		logs.query.mockReturnValueOnce(next.promise);
		const more = screen.getByTestId("raw-load-more-bottom");
		more.focus();
		await fireEvent.click(more);

		next.resolve(page(["s=1"]));
		await screen.findByTestId("raw-end-bottom");
		await waitFor(() =>
			expect(
				document.activeElement?.closest<HTMLElement>('[data-testid="raw-row"]')
					?.dataset.cursor,
			).toBe("s=2"),
		);
		expect(document.activeElement?.getAttribute("tabindex")).toBe("0");
	});

	it("hands focus to Load more when the page Keep searching lands has more", async () => {
		await mounted(page(["s=2"], { hasMore: null, continuation: "c1" }));
		const next = Promise.withResolvers<QueryPage>();
		logs.query.mockReturnValueOnce(next.promise);
		const keep = screen.getByTestId("raw-keep-searching-bottom");
		keep.focus();
		await fireEvent.click(keep);

		next.resolve(page(["s=1"], { hasMore: true, continuation: "c2" }));
		const more = await screen.findByTestId("raw-load-more-bottom");
		await waitFor(() => expect(document.activeElement).toBe(more));
	});

	it("hands focus to Reset filters when Keep searching lands on an empty end", async () => {
		await mounted(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		const next = Promise.withResolvers<QueryPage>();
		logs.query.mockReturnValueOnce(next.promise);
		const keep = screen.getByTestId("raw-keep-searching-bottom");
		keep.focus();
		await fireEvent.click(keep);

		next.resolve(page([]));
		const reset = await screen.findByTestId("raw-reset-filters");
		await waitFor(() => expect(document.activeElement).toBe(reset));
	});

	it("hands focus to the list when the page that lands leaves it no action", async () => {
		await mounted(
			page([], { hasMore: null, termination: "budget", continuation: "c1" }),
		);
		const next = Promise.withResolvers<LogQueryOutput>();
		logs.query.mockReturnValueOnce(next.promise);
		const keep = screen.getByTestId("raw-keep-searching-bottom");
		keep.focus();
		await fireEvent.click(keep);

		next.resolve({ ok: false, error: "CURSOR_UNAVAILABLE" });
		await screen.findByRole("alert");
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByTestId("raw-scroller")),
		);
	});

	it.each(["CURSOR_UNAVAILABLE", "FILTER_CHANGED"] as const)(
		"states the expired position after %s and starts from newest",
		async (code) => {
			await mounted(page(["s=2"], { hasMore: true, continuation: "c1" }));
			logs.query.mockResolvedValueOnce({
				ok: false,
				error: code,
			});
			await fireEvent.click(screen.getByTestId("raw-load-more-bottom"));
			const band = await screen.findByRole("alert");
			expect(band.dataset.code).toBe(code);
			expect(
				within(band).getByText(en.systemLogs.error.expiredTitle),
			).toBeTruthy();
			expect(
				within(band).getByText(en.systemLogs.error.expiredBody),
			).toBeTruthy();
			expect(band.className).toContain("border-status-warning/30");
			expect(band.className).toContain("bg-status-warning/10");
			expect(cursors()).toEqual(["s=2"]);
			expect(screen.queryByTestId("raw-load-more-bottom")).toBeNull();
			expect(screen.queryByTestId("raw-end-bottom")).toBeNull();
			logs.query.mockResolvedValueOnce(page(["s=9"]));
			await fireEvent.click(
				within(band).getByRole("button", {
					name: en.systemLogs.error.startFromNewest,
				}),
			);
			expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
			await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		},
	);

	it.each([
		[
			"BOOT_UNAVAILABLE",
			en.systemLogs.error.bootRemoved,
			en.systemLogs.error.showCurrentBoot,
		],
		["BUSY", en.systemLogs.error.busy, en.systemLogs.action.retry],
		["READ_FAILED", en.systemLogs.error.readFailed, en.systemLogs.action.retry],
		[
			"JOURNAL_UNAVAILABLE",
			en.systemLogs.error.readFailed,
			en.systemLogs.action.retry,
		],
		[
			"RECORD_TOO_LARGE",
			en.systemLogs.error.readFailed,
			en.systemLogs.action.retry,
		],
	] as const)(
		"names %s and offers its recovery",
		async (code, text, action) => {
			logs.query.mockResolvedValueOnce({ ok: false, error: code });
			render(RawLogsTab);
			const band = await screen.findByRole("alert");
			expect(band.dataset.code).toBe(code);
			expect(within(band).getByText(text)).toBeTruthy();
			expect(band.querySelectorAll("p")).toHaveLength(1);
			expect(screen.queryByTestId("raw-empty")).toBeNull();
			expect(screen.queryByTestId("raw-keep-searching-bottom")).toBeNull();
			logs.query.mockResolvedValueOnce(page(["s=1"]));
			await fireEvent.click(within(band).getByRole("button", { name: action }));
			expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
			await waitFor(() => expect(cursors()).toEqual(["s=1"]));
		},
	);

	it("marks the end below a single entry", async () => {
		await mounted(page(["s=1"]));
		expect(screen.getByTestId("raw-end-bottom").textContent?.trim()).toBe(
			en.systemLogs.raw.end,
		);
	});

	it("states the display limit instead of Load more", async () => {
		const many = Array.from({ length: 100 }, (_, index) => `s=${index}`);
		await mounted(page(many, { hasMore: true, continuation: "c0" }));
		for (let round = 1; round <= 20; round += 1) {
			const next = Array.from(
				{ length: 100 },
				(_, index) => `r${round}-${index}`,
			);
			logs.query.mockResolvedValueOnce(
				page(next, { hasMore: true, continuation: `c${round}` }),
			);
			await fireEvent.click(await screen.findByTestId("raw-load-more-bottom"));
			await waitFor(() => expect(logs.query).toHaveBeenCalledTimes(round + 1));
		}
		const cap = await screen.findByTestId("raw-cap");
		has(cap, "text-muted-foreground", "px-4", "py-3", "text-center", "text-xs");
		expect(cap.textContent?.trim()).toBe(
			en.systemLogs.raw.capReached.replace("{count}", "2000"),
		);
		expect(screen.queryByTestId("raw-load-more-bottom")).toBeNull();
	});
});

describe("RawLogsTab: follow", () => {
	it("is an outline button named Follow next to nothing while idle", async () => {
		await mounted();
		const button = screen.getByTestId("raw-follow-button");
		expect(button.textContent?.trim()).toBe(en.systemLogs.follow.start);
		expect(button.className).toContain("border-border");
		expect(button.className).not.toContain("bg-primary");
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(screen.queryByTestId("raw-follow-state")).toBeNull();
		expect(screen.queryByTestId("raw-follow-reason")).toBeNull();
		expect(button.getAttribute("aria-describedby")).toBeNull();
	});

	it("is disabled with a visible reason when the order is Oldest first", async () => {
		await mounted();
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			screen.getByRole("radio", { name: en.systemLogs.raw.orderOldest }),
		);
		const button = screen.getByTestId("raw-follow-button");
		expect(button.hasAttribute("disabled")).toBe(true);
		const reason = screen.getByTestId("raw-follow-reason");
		expect(reason.textContent?.trim()).toBe(en.systemLogs.follow.unavailable);
		expect(button.getAttribute("aria-describedby")).toBe(reason.id);
		expect(reason.parentElement).toBe(button.parentElement);
	});

	it("follows after the newest row and shows the Following state", async () => {
		await mounted();
		await startFollowing();
		expect(logs.followStart).toHaveBeenCalledExactlyOnceWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "s=3",
		});
		const state = screen.getByTestId("raw-follow-state");
		expect(state.dataset.state).toBe("following");
		const dot = state.querySelector("[data-follow-dot]");
		expect(dot?.className).toContain("bg-status-info");
		expect(dot?.className).toContain("motion-safe:animate-pulse");
		expect(screen.getByTestId("raw-follow-button").textContent?.trim()).toBe(
			en.systemLogs.follow.pause,
		);
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.following,
		);
	});

	it("prepends batches, adds no duplicate row and one dropped marker", async () => {
		await mounted();
		await startFollowing();
		push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		await tick();
		push({
			entries: [entry("s=4"), entry("s=5")],
			dropped: 3,
			checkpointCursor: "s=5",
		});
		await waitFor(() =>
			expect(cursors()).toEqual(["s=5", "s=4", "s=3", "s=2", "s=1"]),
		);
		const markers = screen.getAllByTestId("raw-marker");
		expect(markers).toHaveLength(1);
		expect(markers[0]?.textContent?.trim()).toBe(
			en.systemLogs.marker.dropped.replace("{count}", "3"),
		);
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.gap,
		);
	});

	it("with no rows, pauses before any batch and resumes from the stop checkpoint", async () => {
		await mounted(page([]));
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head-1",
		});
		logs.query.mockResolvedValueOnce(page([]));
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head-1",
		});
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.following);
		// With no row, Follow learns the head, reads it again, then starts after it.
		await waitFor(() => expect(logs.followStart).toHaveBeenCalledTimes(2));
		expect(logs.followStart).toHaveBeenNthCalledWith(1, {
			sources: [],
			levels: ["error", "warning", "info"],
		});
		expect(logs.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "head-1",
		});
		logs.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "head-2",
		});
		await fireEvent.click(
			screen.getByRole("button", { name: en.systemLogs.follow.pause }),
		);
		await waitFor(() =>
			expect(screen.getByTestId("raw-follow-state").dataset.state).toBe(
				"paused",
			),
		);
		expect(screen.getByTestId("raw-follow-state").textContent?.trim()).toBe(
			en.systemLogs.follow.paused,
		);
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.paused,
		);
		const resume = await screen.findByRole("button", {
			name: en.systemLogs.follow.resume,
		});
		await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "head-2",
		});
		await fireEvent.click(resume);
		expect(logs.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "head-2",
		});
		await waitFor(() =>
			expect(screen.getByTestId("raw-status").textContent).toBe(
				en.systemLogs.announce.resumed,
			),
		);
	});

	it("keeps the button focusable but busy and unavailable while the device answers", async () => {
		await mounted();
		logs.followStart.mockReturnValueOnce(new Promise(() => {}));
		const button = screen.getByTestId("raw-follow-button");
		await fireEvent.click(button);
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-busy")).toBe("true");
		has(
			button,
			"aria-disabled:pointer-events-none",
			"aria-disabled:opacity-50",
		);
		await fireEvent.click(button);
		expect(logs.followStart).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("raw-follow-reason")).toBeNull();
	});

	it("states why following stopped and offers Follow again", async () => {
		await mounted();
		await startFollowing();
		push({ ended: "follower_exit", checkpointCursor: "s=3" });
		const ended = await screen.findByTestId("raw-follow-ended");
		expect(ended.textContent?.trim()).toBe(en.systemLogs.follow.endedReader);
		expect(screen.getByTestId("raw-follow-state").textContent?.trim()).toBe(
			en.systemLogs.follow.stopped,
		);
		expect(screen.getByTestId("raw-follow-button").textContent?.trim()).toBe(
			en.systemLogs.follow.start,
		);
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.stopped,
		);
	});

	it("resets the list when the logs were cleared", async () => {
		await mounted();
		await startFollowing();
		logs.query.mockResolvedValueOnce(page(["fresh"]));
		push({ ended: "cleared" });
		await waitFor(() => expect(cursors()).toEqual(["fresh"]));
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(screen.getByTestId("raw-follow-ended").textContent?.trim()).toBe(
			en.systemLogs.follow.endedCleared,
		);
	});

	it("reports cleared logs rather than a restart when Clear lands during Pause", async () => {
		await mounted();
		await startFollowing();
		const stop =
			Promise.withResolvers<Awaited<ReturnType<typeof logs.followStop>>>();
		logs.followStop.mockReturnValueOnce(stop.promise);
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.paused);

		logs.query.mockResolvedValueOnce(page(["fresh"]));
		push({ ended: "cleared" });
		stop.resolve({ success: true, checkpointCursor: null });

		await waitFor(() => expect(cursors()).toEqual(["fresh"]));
		expect(screen.getByTestId("raw-follow-ended").textContent?.trim()).toBe(
			en.systemLogs.follow.endedCleared,
		);
		expect(screen.getByTestId("raw-follow-state").dataset.state).toBe(
			"stopped",
		);
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.stopped,
		);
	});

	it("states a restarted device as the reason", async () => {
		await mounted();
		await startFollowing();
		push({ ended: "boot_changed" });
		expect(
			(await screen.findByTestId("raw-follow-ended")).textContent?.trim(),
		).toBe(en.systemLogs.follow.endedBoot);
	});

	it("holds entries while scrolled away and merges them from the New entries button", async () => {
		await mounted();
		await startFollowing();
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 300;
		await fireEvent.scroll(scroller);
		push({ entries: [entry("s=4"), entry("s=5")], checkpointCursor: "s=5" });
		const held = await screen.findByTestId("raw-held");
		expect(held.textContent?.trim()).toBe(
			en.systemLogs.follow.newEntries.replace("{count}", "2"),
		);
		expect(cursors()).toEqual(["s=3", "s=2", "s=1"]);
		await fireEvent.click(held);
		await waitFor(() =>
			expect(cursors()).toEqual(["s=5", "s=4", "s=3", "s=2", "s=1"]),
		);
		expect(scroller.scrollTop).toBe(0);
		expect(screen.queryByTestId("raw-held")).toBeNull();
	});

	it("holds entries from 8px below the top", async () => {
		await mounted();
		await startFollowing();
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 8;
		await fireEvent.scroll(scroller);
		push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		expect((await screen.findByTestId("raw-held")).textContent?.trim()).toBe(
			en.systemLogs.follow.newEntries.replace("{count}", "1"),
		);
		expect(cursors()).toEqual(["s=3", "s=2", "s=1"]);
	});

	it("goes back to prepending once scrolled to the top", async () => {
		await mounted();
		await startFollowing();
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 300;
		await fireEvent.scroll(scroller);
		scroller.scrollTop = 0;
		await fireEvent.scroll(scroller);
		push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		await waitFor(() => expect(cursors()[0]).toBe("s=4"));
	});

	it("stops the follow and clears the listener on unmount", async () => {
		const view = await mounted();
		await startFollowing();
		expect(follow.listener).toBeTypeOf("function");
		view.unmount();
		expect(logs.followStop).toHaveBeenCalledTimes(1);
		expect(follow.listener).toBeUndefined();
	});

	it("switches to Disconnected, dims the rows and offers Resume after reconnecting", async () => {
		await mounted();
		await startFollowing();
		setConnectionState("disconnected");
		await waitFor(() =>
			expect(screen.getByTestId("raw-follow-state").dataset.state).toBe(
				"disconnected",
			),
		);
		expect(screen.getByTestId("raw-follow-state").textContent?.trim()).toBe(
			en.systemLogs.follow.disconnected,
		);
		expect(screen.getByTestId("raw-disconnected").textContent?.trim()).toBe(
			en.systemLogs.follow.disconnectedBody,
		);
		expect(document.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
		expect(
			screen
				.getAllByTestId("raw-row")
				.every((row) => row.dataset.stale === "true"),
		).toBe(true);
		expect(screen.queryByTestId("raw-follow-button")).toBeNull();
		expect(screen.getByTestId("raw-status").textContent).toBe(
			en.systemLogs.announce.disconnected,
		);
		setConnectionState("connected");
		const resume = await screen.findByRole("button", {
			name: en.systemLogs.follow.resume,
		});
		expect(screen.getByTestId("raw-disconnected")).toBeTruthy();
		expect(logs.followStart).toHaveBeenCalledTimes(1);
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=3",
		});
		await fireEvent.click(resume);
		await waitFor(() =>
			expect(screen.queryByTestId("raw-disconnected")).toBeNull(),
		);
		expect(
			screen
				.getAllByTestId("raw-row")
				.every((row) => row.dataset.stale === "false"),
		).toBe(true);
	});

	it("stops follow and reloads This boot after a device restart", async () => {
		const running = fourBoots().find(({ current }) => current);
		if (!running) throw new Error("missing running boot fixture");
		const oldCursor = `s=3;b=${BOOT};m=123`;
		const newCursor = `s=2;b=${running.bootId};m=124`;
		await mounted(page([oldCursor]));
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: oldCursor,
		});
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.following);
		setConnectionState("disconnected");
		await screen.findByTestId("raw-disconnected");

		logs.boots.mockResolvedValueOnce([running]);
		logs.query.mockResolvedValueOnce(
			page([], {
				bootId: running.bootId,
				entries: [entry(newCursor, { bootId: running.bootId })],
			}),
		);
		const bootReads = logs.boots.mock.calls.length;
		setSocketAuthenticated(false);
		setConnectionState("connected");
		await tick();
		expect(logs.boots).toHaveBeenCalledTimes(bootReads);
		expect(screen.getByTestId("raw-disconnected")).toBeTruthy();
		setSocketAuthenticated(true);

		expect(
			(await screen.findByTestId("raw-follow-ended")).textContent?.trim(),
		).toBe(en.systemLogs.follow.endedBoot);
		expect(screen.getByTestId("raw-follow-state").dataset.state).toBe(
			"stopped",
		);
		await waitFor(() => expect(cursors()).toEqual([newCursor]));
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(logs.followStart).toHaveBeenCalledTimes(1);
	});

	it("waits for a held boot check and replaces stale rows when the server finds the reboot", async () => {
		const running = fourBoots().find(({ current }) => current);
		if (!running) throw new Error("missing running boot fixture");
		const oldCursor = `s=3;b=${BOOT};m=123`;
		const newCursor = `s=2;b=${running.bootId};m=124`;
		await mounted(page([oldCursor]));
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: oldCursor,
		});
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.following);
		setConnectionState("disconnected");
		await screen.findByTestId("raw-disconnected");

		const check = Promise.withResolvers<never>();
		logs.boots.mockReturnValueOnce(check.promise);
		setConnectionState("connected");
		const resume = await screen.findByRole("button", {
			name: en.systemLogs.follow.resume,
		});
		expect(resume.getAttribute("aria-busy")).toBe("true");
		await fireEvent.click(resume);
		expect(logs.followStart).toHaveBeenCalledTimes(1);
		check.reject(new Error("boot check was unavailable"));
		await waitFor(() => expect(resume.hasAttribute("aria-busy")).toBe(false));

		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: `boot-start:${running.bootId}:0`,
		});
		logs.query.mockResolvedValueOnce(
			page([], {
				bootId: running.bootId,
				entries: [entry(newCursor, { bootId: running.bootId })],
			}),
		);
		await fireEvent.click(resume);

		expect((await screen.findByTestId("raw-follow-ended")).textContent).toBe(
			en.systemLogs.follow.endedBoot,
		);
		await waitFor(() => expect(cursors()).toEqual([newCursor]));
		expect(logs.followStop).toHaveBeenCalledTimes(1);
		expect(logs.followStart).toHaveBeenCalledTimes(2);
	});

	it.each(["idle", "stopped", "paused"] as const)(
		"refreshes This boot on reconnect from %s without starting follow",
		async (state) => {
			const running = fourBoots().find(({ current }) => current);
			if (!running) throw new Error("missing running boot fixture");
			await mounted(page(["old-boot-row"]));
			const starts = state === "idle" ? 0 : 1;
			if (state === "stopped") {
				await startFollowing();
				push({ ended: "follower_exit" });
				await screen.findByTestId("raw-follow-ended");
			}
			if (state === "paused") {
				await startFollowing();
				await fireEvent.click(screen.getByTestId("raw-follow-button"));
				await screen.findByText(en.systemLogs.follow.paused);
			}
			setConnectionState("disconnected");
			await screen.findByTestId("raw-disconnected");
			logs.boots.mockResolvedValueOnce([running]);
			logs.query.mockResolvedValueOnce(
				page([], {
					bootId: running.bootId,
					entries: [entry("running-boot-row", { bootId: running.bootId })],
				}),
			);
			setConnectionState("connected");

			await waitFor(() => expect(cursors()).toEqual(["running-boot-row"]));
			// Nothing was following, so nothing stopped: the view stays idle and says what happened.
			expect(screen.getByTestId("raw-follow-ended").textContent).toBe(
				en.systemLogs.follow.bootChangedIdle,
			);
			expect(screen.queryByTestId("raw-follow-state")).toBeNull();
			expect(screen.getByTestId("raw-follow-button").textContent?.trim()).toBe(
				en.systemLogs.follow.start,
			);
			expect(screen.getByTestId("raw-status").textContent).toBe(
				en.systemLogs.follow.bootChangedIdle,
			);
			expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
			expect(logs.followStart).toHaveBeenCalledTimes(starts);
		},
	);

	it("pages skipped rows in place and transfers focus when the gap is filled", async () => {
		await mounted();
		await startFollowing();
		push({
			gap: "catchup_exceeded",
			checkpointCursor: "s=7",
			...{ gapFrom: "next1" },
		});
		push({ entries: [entry("s=8")], checkpointCursor: "s=8" });
		const action = await screen.findByRole("button", {
			name: "Show skipped entries",
		});
		action.focus();
		const reply = Promise.withResolvers<QueryPage>();
		logs.query.mockReturnValueOnce(reply.promise);
		await fireEvent.click(action);
		expect(document.activeElement).toBe(action);
		reply.resolve(
			page(["s=4", "s=5"], {
				hasMore: true,
				continuation: "next2",
				termination: "lookahead",
			}),
		);
		await waitFor(() =>
			expect(cursors()).toEqual(["s=8", "s=5", "s=4", "s=3", "s=2", "s=1"]),
		);
		expect(
			screen.getByRole("button", { name: "Show more skipped entries" }),
		).toBe(action);
		expect(document.activeElement).toBe(action);
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			direction: "newer",
			continuation: "next1",
		});
		logs.query.mockResolvedValueOnce(page(["s=6", "s=7"]));
		await fireEvent.click(action);
		await waitFor(() =>
			expect(cursors()).toEqual([
				"s=8",
				"s=7",
				"s=6",
				"s=5",
				"s=4",
				"s=3",
				"s=2",
				"s=1",
			]),
		);
		await waitFor(() =>
			expect(
				document.activeElement
					?.closest("[data-cursor]")
					?.getAttribute("data-cursor"),
			).toBe("s=7"),
		);
		expect(screen.queryByTestId("raw-marker")).toBeNull();
		expect(logs.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			direction: "newer",
			continuation: "next2",
		});
	});

	it("shows the out-of-date notice while the socket is down even without a follow", async () => {
		await mounted();
		setConnectionState("disconnected");
		await screen.findByTestId("raw-disconnected");
		expect(screen.queryByTestId("raw-follow-state")).toBeNull();
		setConnectionState("connected");
		await waitFor(() =>
			expect(screen.queryByTestId("raw-disconnected")).toBeNull(),
		);
	});
});

describe("RawLogsTab: unknown moment", () => {
	async function opened() {
		logs.query.mockResolvedValueOnce(page(["s=3", "s=2", "s=1"]));
		render(RawLogsTab, { momentUnknown: true });
		await waitFor(() => expect(screen.queryByTestId("raw-loading")).toBeNull());
		expect(screen.getByTestId("raw-moment-unknown").textContent?.trim()).toBe(
			en.systemLogs.anchor.unknown,
		);
	}

	it("dismisses the line once Follow starts, for the rest of the opening", async () => {
		await opened();
		await startFollowing();
		expect(screen.queryByTestId("raw-moment-unknown")).toBeNull();
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.paused);
		expect(screen.queryByTestId("raw-moment-unknown")).toBeNull();
	});

	it("dismisses the line at the first filter change and keeps it gone on the default filter", async () => {
		await opened();
		const group = screen.getByRole("radiogroup", {
			name: en.systemLogs.raw.levelLabel,
		});
		logs.query.mockResolvedValueOnce(page(["e=1"]));
		await fireEvent.click(
			within(group).getByRole("radio", { name: en.systemLogs.raw.levelErrors }),
		);
		await waitFor(() => expect(cursors()).toEqual(["e=1"]));
		expect(screen.queryByTestId("raw-moment-unknown")).toBeNull();
		logs.query.mockResolvedValueOnce(page(["s=3"]));
		await fireEvent.click(
			within(group).getByRole("radio", { name: en.systemLogs.raw.levelInfo }),
		);
		await waitFor(() => expect(cursors()).toEqual(["s=3"]));
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(screen.queryByTestId("raw-moment-unknown")).toBeNull();
	});

	it("keeps the line when opening on the running boot, which is the default filter", async () => {
		const running = fourBoots().find(({ current }) => current);
		if (!running) throw new Error("missing running boot fixture");
		bootSelection.choose(running);
		await opened();
		expect(logs.query).toHaveBeenCalledExactlyOnceWith(DEFAULT_INPUT);
	});
});

describe("RawLogsTab: history and rows", () => {
	it("starts over when stored history changes", async () => {
		await mounted(page(["s=2"], { hasMore: true, continuation: "c1" }));
		logs.query.mockResolvedValueOnce(page(["n=1"]));
		notifyHistoryChanged();
		await waitFor(() => expect(cursors()).toEqual(["n=1"]));
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
	});

	it("stops listening for history changes on unmount", async () => {
		const view = await mounted();
		view.unmount();
		notifyHistoryChanged();
		expect(logs.query).toHaveBeenCalledTimes(1);
	});

	it("expands a row on click and collapses it again", async () => {
		await mounted();
		const [first] = screen.getAllByTestId("raw-row");
		const button = within(first as HTMLElement).getByRole("button");
		await fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(
			within(first as HTMLElement).getByTestId("raw-row-detail"),
		).toBeTruthy();
		await fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		const buttons = screen
			.getAllByTestId("raw-row")
			.map((row) => within(row).getByRole("button"));
		await fireEvent.click(buttons[2] as HTMLElement);
		expect(buttons.map((row) => row.tabIndex)).toEqual([-1, -1, 0]);
	});

	it("places each row below the measured height of the row above", async () => {
		// Browsers report row heights through ResizeObserver; jsdom has none.
		const height = (target: Element) =>
			target.querySelector('[data-testid="raw-date"]') ? 28 : 36;
		class MeasuringObserver {
			readonly #callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.#callback = callback;
			}
			observe(target: Element): void {
				queueMicrotask(() =>
					this.#callback(
						[
							{
								target,
								borderBoxSize: [
									{ blockSize: height(target), inlineSize: 1000 },
								],
								contentBoxSize: [],
								devicePixelContentBoxSize: [],
								contentRect: target.getBoundingClientRect(),
							},
						],
						this,
					),
				);
			}
			unobserve(): void {}
			disconnect(): void {}
		}
		const view = document.defaultView as unknown as Record<string, unknown>;
		view.ResizeObserver = MeasuringObserver;
		try {
			await mounted(page(["s=2", "s=1"]));
			const list = screen.getByTestId("raw-list");
			await waitFor(() =>
				expect(
					[...list.querySelectorAll("li")].map((item) => item.style.transform),
				).toEqual(["translateY(0px)", "translateY(28px)", "translateY(64px)"]),
			);
			expect(list.style.height).toBe("100px");
		} finally {
			delete view.ResizeObserver;
		}
	});

	it("keeps a visible row tabbable after manual virtual scrolling", async () => {
		scrollerHeight = 400;
		await mounted(
			page(Array.from({ length: 100 }, (_, index) => `s=${index}`)),
		);
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 1800;
		await fireEvent.scroll(scroller);
		await waitFor(() => expect(cursors()).not.toContain("s=0"));
		const stops = [
			...scroller.querySelectorAll<HTMLButtonElement>(
				'[data-testid="raw-row"] > button',
			),
		].filter((button) => button.tabIndex === 0);
		expect(
			stops.map((button) =>
				button.closest("[data-cursor]")?.getAttribute("data-cursor"),
			),
		).toEqual(["s=49"]);
		const rendered = [...scroller.querySelectorAll("li")].map((item) =>
			Number(item.dataset.index),
		);
		expect([rendered[0], rendered.at(-1)]).toEqual([38, 73]);
	});

	it("does not count a row whose top edge sits on the viewport's bottom edge as visible", async () => {
		scrollerHeight = 400;
		await mounted(
			page(Array.from({ length: 100 }, (_, index) => `s=${index}`)),
		);
		const row = (cursor: string) =>
			screen
				.getAllByTestId("raw-row")
				.find((item) => item.dataset.cursor === cursor)
				?.querySelector<HTMLButtonElement>(
					":scope > button",
				) as HTMLButtonElement;
		const scroller = screen.getByTestId("raw-scroller");
		const firstRendered = () =>
			scroller.querySelector<HTMLElement>("li")?.dataset.index;
		scroller.scrollTop = 400;
		await fireEvent.scroll(scroller);
		await waitFor(() => expect(row("s=24")).toBeTruthy());
		await fireEvent.click(row("s=24"));
		// s=24 starts at 900px: exactly the bottom edge of a 400px view at 500px.
		scroller.scrollTop = 500;
		await fireEvent.scroll(scroller);
		await waitFor(() => expect(firstRendered()).toBe("1"));
		const stops = [
			...scroller.querySelectorAll<HTMLButtonElement>(
				'[data-testid="raw-row"] > button',
			),
		].filter((button) => button.tabIndex === 0);
		expect(
			stops.map((button) =>
				button.closest("[data-cursor]")?.getAttribute("data-cursor"),
			),
		).toEqual(["s=12"]);
	});

	it("reaches the last entry with End and keeps it in view", async () => {
		scrollerHeight = 400;
		await mounted(
			page(Array.from({ length: 100 }, (_, index) => `s=${index}`)),
		);
		const focused = () =>
			document.activeElement
				?.closest("[data-cursor]")
				?.getAttribute("data-cursor");
		const first = within(
			screen.getAllByTestId("raw-row")[0] as HTMLElement,
		).getByRole("button");
		first.focus();
		await fireEvent.keyDown(first, { key: "End" });
		await waitFor(() => expect(focused()).toBe("s=99"));
		await tick();
		expect(focused()).toBe("s=99");
		expect(screen.getByTestId("raw-scroller").scrollTop).toBeGreaterThan(3000);
	});

	it("does not pull focus back to a row the keyboard left once it re-renders", async () => {
		scrollerHeight = 400;
		await mounted(
			page(Array.from({ length: 100 }, (_, index) => `s=${index}`)),
		);
		const first = within(
			screen.getAllByTestId("raw-row")[0] as HTMLElement,
		).getByRole("button");
		first.focus();
		await fireEvent.keyDown(first, { key: "ArrowDown" });
		await waitFor(() =>
			expect(
				document.activeElement
					?.closest("[data-cursor]")
					?.getAttribute("data-cursor"),
			).toBe("s=1"),
		);
		const search = screen.getByTestId("raw-search");
		search.focus();
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 1800;
		await fireEvent.scroll(scroller);
		await waitFor(() => expect(cursors()).not.toContain("s=1"));
		scroller.scrollTop = 0;
		await fireEvent.scroll(scroller);
		await waitFor(() => expect(cursors()).toContain("s=1"));
		await tick();
		expect(document.activeElement).toBe(search);
	});

	it("moves between rows with the arrow keys as one tab stop", async () => {
		await mounted();
		const buttons = () =>
			screen
				.getAllByTestId("raw-row")
				.map((row) => within(row).getByRole("button"));
		expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
		buttons()[0]?.focus();
		expect(
			await fireEvent.keyDown(buttons()[0] as HTMLElement, {
				key: "ArrowDown",
			}),
		).toBe(false);
		await waitFor(() => expect(document.activeElement).toBe(buttons()[1]));
		expect(buttons().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
		await fireEvent.keyDown(buttons()[1] as HTMLElement, { key: "End" });
		await waitFor(() => expect(document.activeElement).toBe(buttons()[2]));
		await fireEvent.keyDown(buttons()[2] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(buttons()[2]);
		expect(buttons().map((button) => button.tabIndex)).toEqual([-1, -1, 0]);
		await fireEvent.keyDown(buttons()[2] as HTMLElement, { key: "Home" });
		await waitFor(() => expect(document.activeElement).toBe(buttons()[0]));
		await fireEvent.keyDown(buttons()[0] as HTMLElement, { key: "ArrowUp" });
		expect(document.activeElement).toBe(buttons()[0]);
		await fireEvent.keyDown(buttons()[0] as HTMLElement, { key: "ArrowDown" });
		await fireEvent.keyDown(buttons()[1] as HTMLElement, { key: "ArrowUp" });
		await waitFor(() => expect(document.activeElement).toBe(buttons()[0]));
	});

	it("leaves other keys to the row", async () => {
		await mounted();
		const button = within(
			screen.getAllByTestId("raw-row")[0] as HTMLElement,
		).getByRole("button");
		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		button.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it("opens each day with a date row", async () => {
		await mounted();
		expect(screen.getAllByTestId("raw-date")).toHaveLength(1);
		expect(screen.getByTestId("raw-date").textContent?.trim()).toMatch(
			/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
		);
		expect(
			screen
				.getAllByTestId("raw-row")[0]
				?.querySelector("time")
				?.textContent?.trim(),
		).toMatch(/^\d{2}:\d{2}:\d{2}( [AP]M)?$/);
	});
});

describe("RawLogsTab: anatomy", () => {
	it("lays out the filter bar: Level, Search, Filters and Follow, then Source, Time and Order", async () => {
		await mounted();
		const bar = screen.getByTestId("raw-filters");
		has(bar, "@container", "border-b");
		has(
			bar.firstElementChild,
			"flex",
			"flex-wrap",
			"items-center",
			"gap-2",
			"p-3",
		);
		has(screen.getByTestId("raw-level"), "w-full", "@min-[30rem]:w-auto");
		const search = screen.getByTestId("raw-search");
		has(search, "ps-8", "pe-9", "min-h-(--touch-target-min)", "text-ellipsis");
		expect(search.getAttribute("enterkeyhint")).toBe("search");
		has(
			search.parentElement?.querySelector("svg"),
			"text-muted-foreground",
			"pointer-events-none",
			"absolute",
			"start-2.5",
			"top-1/2",
			"size-4",
			"-translate-y-1/2",
		);
		const toggle = screen.getByTestId("raw-filters-toggle");
		has(toggle, "gap-1.5", "h-7", "border-border");
		has(toggle.querySelector("svg"), "size-4");
		const sourcesLabel = screen.getByText(en.systemLogs.raw.sourceLabel);
		has(sourcesLabel, "text-muted-foreground", "text-xs", "font-medium");
		has(sourcesLabel.parentElement, "flex", "min-w-40", "flex-col", "gap-1");
		has(screen.getByTestId("raw-sources"), "w-full");
		const timeLabel = screen.getByText(en.systemLogs.raw.timeLabel);
		has(timeLabel, "text-muted-foreground", "text-xs", "font-medium");
		has(timeLabel.parentElement, "flex", "min-w-40", "flex-col", "gap-1");
		has(screen.getByTestId("raw-time"), "w-full");
		const orderLabel = screen.getByTestId("raw-order").previousElementSibling;
		expect(orderLabel?.textContent).toBe(en.systemLogs.raw.orderLabel);
		expect(orderLabel?.getAttribute("aria-hidden")).toBe("true");
		has(orderLabel, "text-muted-foreground", "text-xs", "font-medium");
		has(orderLabel?.parentElement, "flex", "flex-col", "gap-1");
		await fireEvent.input(search, { target: { value: "x" } });
		const clear = screen.getByTestId("raw-search-clear");
		expect(clear.getAttribute("type")).toBe("button");
		has(
			clear,
			"text-muted-foreground",
			"absolute",
			"end-1",
			"top-1/2",
			"grid",
			"size-6",
			"-translate-y-1/2",
			"place-items-center",
			"rounded-md",
		);
		has(clear.querySelector("svg"), "size-4");
	});

	it("lays out the follow control, its state and its reason", async () => {
		await mounted();
		has(
			screen.getByTestId("raw-follow"),
			"flex",
			"min-w-0",
			"flex-wrap",
			"items-center",
			"gap-x-3",
			"gap-y-1",
		);
		const button = screen.getByTestId("raw-follow-button");
		has(button, "gap-1.5", "h-7");
		has(button.querySelector("svg"), "size-4");
		await startFollowing();
		has(screen.getByTestId("raw-follow-button").querySelector("svg"), "size-4");
		has(
			screen.getByTestId("raw-follow-state"),
			"inline-flex",
			"items-center",
			"gap-1.5",
			"text-xs",
			"font-medium",
		);
		has(
			screen.getByTestId("raw-follow-state").querySelector("[data-follow-dot]"),
			"size-2",
			"rounded-full",
		);
		logs.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "s=3",
		});
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await waitFor(() =>
			expect(screen.getByTestId("raw-follow-state").dataset.state).toBe(
				"paused",
			),
		);
		has(
			screen.getByTestId("raw-follow-state").querySelector("[data-follow-dot]"),
			"size-2",
			"rounded-full",
			"bg-status-neutral",
		);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(
			screen.getByRole("radio", { name: en.systemLogs.raw.orderOldest }),
		);
		has(
			screen.getByTestId("raw-follow-reason"),
			"text-muted-foreground",
			"text-xs",
		);
	});

	it("lays out the list, its rows and its loading rows", async () => {
		let release: (page: QueryPage) => void = () => {};
		logs.query.mockReturnValueOnce(
			new Promise((resolve) => (release = resolve)),
		);
		render(RawLogsTab);
		has(
			screen.getByTestId("raw-logs"),
			"flex",
			"h-full",
			"min-h-0",
			"flex-col",
			// CJK copy: phrase breaks in Japanese, space breaks in Korean, no lone last character.
			"text-pretty",
			"[word-break:auto-phrase]",
			"[&:lang(ko)]:break-keep",
		);
		const loading = screen.getByTestId("raw-loading");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		const skeletonRow = loading.querySelector("div");
		has(skeletonRow, "flex", "gap-3", "px-4", "py-2");
		const bones = skeletonRow?.querySelectorAll('[data-slot="skeleton"]') ?? [];
		has(bones[0], "size-4", "rounded-full");
		has(bones[0]?.nextElementSibling, "flex-1", "space-y-1.5");
		has(bones[1], "h-3", "w-32");
		has(bones[2], "h-3", "w-full");
		release(page(["s=2", "s=1"]));
		await waitFor(() => expect(cursors()).toEqual(["s=2", "s=1"]));
		const scroller = screen.getByTestId("raw-scroller");
		has(
			scroller,
			"@container",
			"min-h-0",
			"flex-1",
			"overflow-y-auto",
			"overscroll-contain",
		);
		has(
			scroller.parentElement,
			"relative",
			"flex",
			"min-h-0",
			"flex-1",
			"flex-col",
		);
		const list = screen.getByTestId("raw-list");
		has(list, "relative");
		expect(list.style.height).toBe("108px");
		const items = [...list.querySelectorAll("li")];
		expect(items.map((item) => item.dataset.index)).toEqual(["0", "1", "2"]);
		expect(items.map((item) => item.style.transform)).toEqual([
			"translateY(0px)",
			"translateY(36px)",
			"translateY(72px)",
		]);
		for (const item of items) has(item, "absolute", "inset-x-0", "top-0");
	});

	it("lays out paging, end and held states", async () => {
		await mounted(page(["s=2"], { hasMore: true, continuation: "c1" }));
		const more = screen.getByTestId("raw-load-more-bottom");
		has(more, "h-7", "border-border");
		has(more.parentElement, "flex", "justify-center", "px-4", "py-3");
		logs.query.mockResolvedValueOnce(
			page(["s=1"], { hasMore: null, continuation: "c2" }),
		);
		await fireEvent.click(more);
		const keep = await screen.findByTestId("raw-keep-searching-bottom");
		has(keep, "h-7", "border-border");
		has(
			keep.parentElement,
			"flex",
			"flex-col",
			"items-center",
			"gap-2",
			"px-4",
			"py-3",
			"text-center",
		);
		has(
			screen.getByText(en.systemLogs.raw.keepSearchingHint),
			"text-muted-foreground",
			"max-w-prose",
			"text-xs",
		);
		logs.query.mockResolvedValueOnce(page([]));
		await fireEvent.click(keep);
		const end = await screen.findByTestId("raw-end-bottom");
		has(
			end,
			"text-muted-foreground",
			"flex",
			"items-center",
			"gap-3",
			"px-4",
			"py-3",
			"text-xs",
			"before:bg-border",
			"before:h-px",
			"before:flex-1",
			"after:bg-border",
			"after:h-px",
			"after:flex-1",
		);
		logs.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=2",
		});
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.following);
		const scroller = screen.getByTestId("raw-scroller");
		scroller.scrollTop = 300;
		await fireEvent.scroll(scroller);
		push({ entries: [entry("s=3")], checkpointCursor: "s=3" });
		const held = await screen.findByTestId("raw-held");
		has(
			held,
			"absolute",
			"inset-x-0",
			"top-2",
			"z-10",
			"mx-auto",
			"w-fit",
			"shadow-sm",
			"h-7",
			"bg-secondary",
		);
	});

	it("lays out the empty state", async () => {
		await mounted(page([]));
		const empty = screen.getByTestId("raw-empty");
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
		has(
			within(empty).getByText(en.systemLogs.raw.emptyTitle),
			"text-sm",
			"font-semibold",
		);
		has(
			within(empty).getByText(en.systemLogs.raw.emptyHint),
			"text-muted-foreground",
			"max-w-prose",
			"text-sm",
		);
		has(
			screen.getByTestId("raw-reset-filters"),
			"mt-2",
			"h-7",
			"border-border",
		);
	});

	it("lays out the notices and the failure band", async () => {
		logs.query.mockResolvedValueOnce({
			ok: false,
			error: "CURSOR_UNAVAILABLE",
		});
		render(RawLogsTab);
		const band = await screen.findByTestId("raw-failure");
		has(
			band,
			"m-3",
			"flex",
			"flex-col",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
			"sm:flex-row",
			"sm:items-center",
		);
		has(band.querySelector("svg"), "text-status-warning", "size-4", "shrink-0");
		const title = within(band).getByText(en.systemLogs.error.expiredTitle);
		has(title, "text-sm", "font-semibold");
		has(title.parentElement, "min-w-0", "flex-1", "space-y-1");
		has(within(band).getByText(en.systemLogs.error.expiredBody), "text-sm");
		has(
			screen.getByTestId("raw-failure-action"),
			"shrink-0",
			"h-7",
			"border-border",
		);
		setConnectionState("disconnected");
		const notice = await screen.findByTestId("raw-disconnected");
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

	it("lays out the stopped reason", async () => {
		await mounted();
		await startFollowing();
		push({ ended: "follower_exit" });
		has(
			await screen.findByTestId("raw-follow-ended"),
			"text-muted-foreground",
			"border-b",
			"px-4",
			"py-2",
			"text-xs",
		);
	});

	it("lays out anchor mode", async () => {
		await mounted(page([]), around({ approximate: true, anchor: null }));
		has(
			screen.getByTestId("raw-anchor"),
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-3",
			"gap-y-1",
			"border-b",
			"px-4",
			"py-2",
		);
		has(
			screen.getByTestId("raw-anchor-approximate"),
			"text-muted-foreground",
			"min-w-0",
			"flex-1",
			"text-xs",
		);
		has(
			screen.getByTestId("raw-anchor-leave"),
			"ms-auto",
			"h-7",
			"dark:hover:bg-muted/50",
		);
		has(screen.getByTestId("raw-top"), "border-b");
		cleanup();
		await mounted(
			page([]),
			around({
				approximate: true,
				anchor: null,
				older: page([]),
				newer: page([]),
			}),
		);
		has(
			screen.getByTestId("raw-anchor-empty"),
			"text-muted-foreground",
			"px-6",
			"py-10",
			"text-center",
			"text-sm",
		);
	});
});

function around(patch: Partial<AroundPage> = {}): AroundPage {
	return {
		ok: true,
		anchor: entry("s=5"),
		approximate: false,
		older: page(["s=4"], { hasMore: false }),
		newer: page(["s=6"], { hasMore: true, continuation: "newer-c" }),
		olderQuery: {
			...DEFAULT_INPUT,
			boot: BOOT,
			limit: 50,
		} as AroundPage["olderQuery"],
		newerQuery: {
			...DEFAULT_INPUT,
			boot: BOOT,
			direction: "newer",
			limit: 50,
		} as AroundPage["newerQuery"],
		...patch,
	};
}

describe("RawLogsTab: anchor mode", () => {
	it("brings an exact anchor into view once the list is laid out", async () => {
		// At mount the list may not be laid out yet; the browser reports its size later.
		const laidOutHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"scrollHeight",
		)?.get;
		let laidOut = false;
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return laidOut ? (laidOutHeight?.call(this) ?? 0) : 0;
			},
		);
		const observers: LayoutObserver[] = [];
		class LayoutObserver {
			readonly callback: ResizeObserverCallback;
			readonly targets: Element[] = [];
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
				observers.push(this);
			}
			observe(target: Element): void {
				this.targets.push(target);
			}
			unobserve(): void {}
			disconnect(): void {}
		}
		const view = document.defaultView as unknown as Record<string, unknown>;
		view.ResizeObserver = LayoutObserver;
		scrollerHeight = 0;
		try {
			render(RawLogsTab, {
				around: around({
					newer: page(
						Array.from({ length: 60 }, (_, index) => `n=${index}`),
						{ hasMore: false },
					),
				}),
			});
			await tick();
			scrollerHeight = 400;
			laidOut = true;
			for (const observer of observers) {
				observer.callback(
					observer.targets.map((target) => ({
						target,
						borderBoxSize: [{ blockSize: 36, inlineSize: 1000 }],
						contentBoxSize: [],
						devicePixelContentBoxSize: [],
						contentRect: target.getBoundingClientRect(),
					})),
					observer as unknown as ResizeObserver,
				);
			}
			await waitFor(() =>
				expect(
					document.activeElement
						?.closest("[data-cursor]")
						?.getAttribute("data-cursor"),
				).toBe("s=5"),
			);
			expect(screen.getByTestId("raw-scroller").scrollTop).toBeGreaterThan(0);
		} finally {
			delete view.ResizeObserver;
		}
	});

	it("highlights and focuses the anchor and blocks Follow with its reason", async () => {
		await mounted(page([]), around());
		expect(logs.query).not.toHaveBeenCalled();
		expect(cursors()).toEqual(["s=6", "s=5", "s=4"]);
		const anchorRow = screen.getAllByTestId("raw-row")[1] as HTMLElement;
		expect(anchorRow.dataset.anchor).toBe("true");
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(anchorRow).getByRole("button"),
			),
		);
		expect(
			screen
				.getAllByTestId("raw-row")
				.map((row) => within(row).getByRole("button").tabIndex),
		).toEqual([-1, 0, -1]);
		expect(screen.getByTestId("raw-follow-reason").textContent?.trim()).toBe(
			en.systemLogs.follow.unavailableAnchor,
		);
		expect(screen.queryByTestId("raw-anchor-approximate")).toBeNull();
		expect(screen.getByTestId("raw-end-bottom")).toBeTruthy();
	});

	it("shows the window's own level and boot, never the return view's", async () => {
		const result = around();
		const all = { levels: ["error", "warning", "info", "debug"] };
		await mounted(
			page([]),
			around({
				olderQuery: {
					...result.olderQuery,
					...all,
				} as AroundPage["olderQuery"],
				newerQuery: {
					...result.newerQuery,
					...all,
				} as AroundPage["newerQuery"],
			}),
		);
		expect(
			within(screen.getByTestId("raw-level"))
				.getByRole("radio", { checked: true })
				.textContent?.trim(),
		).toBe(en.systemLogs.raw.levelEverything);
		expect(screen.getByTestId("raw-time").textContent?.trim()).toBe(
			en.systemLogs.raw.timeBoot,
		);
		expect(screen.getByTestId("raw-filters-toggle").textContent).toContain("1");
	});

	it("marks where the selected moment falls in an approximate window, and names the newer end", async () => {
		const at = Date.UTC(2026, 10, 15, 12, 0, 0);
		const window = around({ anchor: null, approximate: true });
		await mounted(
			page([]),
			around({
				anchor: null,
				approximate: true,
				older: { ...page([]), entries: [entry("s=4", { ts: at - 1000 })] },
				newer: { ...page([]), entries: [entry("s=6", { ts: at + 1000 })] },
				olderQuery: { ...window.olderQuery, until: at },
			}),
		);

		const list = screen.getByTestId("raw-list");
		const order = [
			...list.querySelectorAll<HTMLElement>(
				'[data-testid="raw-row"], [data-testid="raw-moment"]',
			),
		].map((row) => row.dataset.cursor ?? row.dataset.testid);
		expect(order).toEqual(["s=6", "raw-moment", "s=4"]);
		const time = new Intl.DateTimeFormat("en", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).format(at);
		expect(screen.getByTestId("raw-moment").textContent?.trim()).toBe(
			en.systemLogs.anchor.moment.replace("{time}", time),
		);
		const stamp = screen.getByTestId("raw-moment").querySelector("time");
		expect(stamp?.getAttribute("datetime")).toBe(new Date(at).toISOString());
		has(stamp, "tabular-nums");
		// Each side of an approximate window reads only a bounded time range, so neither end speaks for the stored logs.
		expect(screen.getByTestId("raw-end-top").textContent?.trim()).toBe(
			en.systemLogs.raw.endNewerWindow,
		);
		expect(screen.getByTestId("raw-end-bottom").textContent?.trim()).toBe(
			en.systemLogs.raw.endOlderWindow,
		);
	});

	it("keeps the stored-logs wording at both ends of a window around an exact entry", async () => {
		await mounted(
			page([]),
			around({ newer: page(["s=6"], { hasMore: false }) }),
		);
		expect(screen.getByTestId("raw-end-top").textContent?.trim()).toBe(
			en.systemLogs.raw.endNewer,
		);
		expect(screen.getByTestId("raw-end-bottom").textContent?.trim()).toBe(
			en.systemLogs.raw.end,
		);
	});

	it("offers Keep searching at both ends of an approximate window that could not prove them", async () => {
		// logs.around answers hasMore: null when its scan ran out of budget before proving an end.
		const unproven = (cursor: string, continuation: string) =>
			page([cursor], { hasMore: null, termination: "budget", continuation });
		await mounted(
			page([]),
			around({
				anchor: null,
				approximate: true,
				older: unproven("s=4", "older-c"),
				newer: unproven("s=6", "newer-c"),
			}),
		);
		const noWindowEnd = () => {
			expect(screen.queryByTestId("raw-end-top")).toBeNull();
			expect(screen.queryByTestId("raw-end-bottom")).toBeNull();
			expect(screen.queryByText(en.systemLogs.raw.endNewerWindow)).toBeNull();
			expect(screen.queryByText(en.systemLogs.raw.endOlderWindow)).toBeNull();
		};
		expect(screen.getByTestId("raw-keep-searching-top")).toBeTruthy();
		expect(screen.getByTestId("raw-keep-searching-bottom")).toBeTruthy();
		noWindowEnd();

		logs.query.mockResolvedValueOnce(unproven("s=3", "older-c2"));
		await fireEvent.click(screen.getByTestId("raw-keep-searching-bottom"));
		await waitFor(() => expect(cursors()).toEqual(["s=6", "s=4", "s=3"]));
		expect(screen.getByTestId("raw-keep-searching-bottom")).toBeTruthy();
		noWindowEnd();
	});

	it("lets the approximate note take its own line beside a long action, and wrap Chinese only between words", async () => {
		await mounted(page([]), around({ anchor: null, approximate: true }));
		has(
			screen.getByTestId("raw-anchor-approximate"),
			"basis-48",
			"[&:lang(zh)]:break-keep",
		);
		setLocale("zh");
		try {
			await tick();
			expect(
				screen.getByTestId("raw-anchor-approximate").querySelectorAll("wbr")
					.length,
			).toBeGreaterThan(0);
		} finally {
			setLocale("en");
		}
	});

	it("marks no moment when the window holds the exact entry", async () => {
		const window = around();
		await mounted(
			page([]),
			around({
				olderQuery: {
					...window.olderQuery,
					until: Date.UTC(2026, 10, 15, 12, 0, 0),
				},
			}),
		);
		expect(screen.getAllByTestId("raw-row")).toHaveLength(3);
		expect(screen.queryByTestId("raw-moment")).toBeNull();
	});

	it("states an approximate match", async () => {
		await mounted(page([]), around({ anchor: null, approximate: true }));
		expect(
			screen.getByTestId("raw-anchor-approximate").textContent?.trim(),
		).toBe(en.systemLogs.anchor.approximate);
		expect(
			screen
				.queryAllByTestId("raw-row")
				.some((row) => row.dataset.anchor === "true"),
		).toBe(false);
	});

	it("says when no entries remain around the moment", async () => {
		await mounted(
			page([]),
			around({
				anchor: null,
				approximate: true,
				older: page([]),
				newer: page([]),
			}),
		);
		expect(screen.getByTestId("raw-anchor-empty").textContent?.trim()).toBe(
			en.systemLogs.anchor.empty,
		);
		expect(screen.queryByTestId("raw-empty")).toBeNull();
	});

	it("pages toward newer entries with the around query", async () => {
		const result = around();
		await mounted(page([]), result);
		logs.query.mockResolvedValueOnce(page(["s=7"]));
		await fireEvent.click(screen.getByTestId("raw-load-more-top"));
		expect(logs.query).toHaveBeenLastCalledWith({
			...result.newerQuery,
			continuation: "newer-c",
		});
		await waitFor(() =>
			expect(cursors()).toEqual(["s=7", "s=6", "s=5", "s=4"]),
		);
		expect(screen.getByTestId("raw-end-top")).toBeTruthy();
	});

	it("goes back to the latest entries", async () => {
		await mounted(page([]), around());
		logs.query.mockResolvedValueOnce(page(["s=9"]));
		await fireEvent.click(
			screen.getByRole("button", { name: en.systemLogs.anchor.leave }),
		);
		expect(logs.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		await waitFor(() => expect(screen.queryByTestId("raw-anchor")).toBeNull());
		expect(screen.queryByTestId("raw-load-more-top")).toBeNull();
	});
});
