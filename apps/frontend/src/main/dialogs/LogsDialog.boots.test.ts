// @vitest-environment jsdom
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitForElementToBeRemoved,
	within,
} from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";

import { BOOT_IDS, fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import LogsDialogHarness from "./__fixtures__/LogsDialogHarness.svelte";
import LogsDialog from "./LogsDialog.svelte";

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: vi.fn(() => new Promise<unknown>(() => {})),
		boots: vi.fn<() => Promise<LogBootInfo[]>>(),
	},
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({ isStreaming: false, isFullyStale: false }),
}));

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;

beforeAll(() => {
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	rpc.logs.boots.mockReset();
	rpc.logs.boots.mockResolvedValue(fourBoots());
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	bootSelection.reset();
});

function viewport(wide: boolean): void {
	media = installMediaQueries((query) => query === WIDE && wide);
}

const LOGS = { name: en.settings.index.logs };
const SHEET = { name: en.systemLogs.boots.heading };

async function chooseInSheet(bootId: string): Promise<void> {
	await fireEvent.click(await screen.findByTestId("boot-button"));
	const sheet = await screen.findByRole("dialog", SHEET);
	const options = await within(sheet).findAllByTestId("boot-option");
	const option = options.find((element) => element.dataset.bootId === bootId);
	if (option === undefined) throw new Error(`boot ${bootId} is not listed`);
	const closed = waitForElementToBeRemoved(sheet);
	await fireEvent.click(option);
	await closed;
}

function withoutClean(): LogBootInfo[] {
	return fourBoots().filter((boot) => boot.bootId !== BOOT_IDS.clean);
}

describe("LogsDialog — the boot picker in the header", () => {
	it("shows the boot button in the header below 1024 px, outside the title", async () => {
		viewport(false);
		render(LogsDialogHarness);

		const button = await screen.findByTestId("boot-button");
		const title = screen.getByRole("heading", { name: en.settings.index.logs });
		expect(button.closest("[data-app-dialog-header]")).not.toBeNull();
		expect(title.contains(button)).toBe(false);
		expect(
			screen.getByRole("dialog", { name: en.settings.index.logs }),
		).toBeTruthy();
	});

	it("has no boot button at 1024 px and wider, where the side column holds the picker", async () => {
		viewport(true);
		render(LogsDialogHarness);
		await screen.findByTestId("system-logs-stream-pill");
		for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

		expect(screen.queryByTestId("boot-button")).toBeNull();
		expect(rpc.logs.boots).not.toHaveBeenCalled();
	});

	it("closes only the boot sheet on Escape, leaving System Logs open", async () => {
		viewport(false);
		render(LogsDialogHarness);
		await fireEvent.click(await screen.findByTestId("boot-button"));
		const sheet = await screen.findByRole("dialog", {
			name: en.systemLogs.boots.heading,
		});
		expect(await within(sheet).findByRole("listbox")).toBeTruthy();
		const removed = waitForElementToBeRemoved(sheet);

		await fireEvent.keyDown(sheet, { key: "Escape" });

		await removed;
		expect(
			screen.getByRole("dialog", { name: en.settings.index.logs }),
		).toBeTruthy();
		expect(screen.getByTestId("harness-open").textContent).toBe("true");
	});

	it("starts the next open on All boots: closing the view drops the chosen boot", async () => {
		viewport(false);
		const [, clean] = fourBoots();
		render(LogsDialogHarness);
		await screen.findByTestId("boot-button");
		if (clean !== undefined) bootSelection.choose(clean);
		expect(bootSelection.boot).toBe(clean);

		await fireEvent.click(screen.getByTestId("app-dialog-close"));

		expect(screen.getByTestId("harness-open").textContent).toBe("false");
		expect(bootSelection.boot).toBeNull();
	});

	it("keeps the chosen boot while the view stays open", async () => {
		viewport(false);
		const [, clean] = fourBoots();
		render(LogsDialogHarness);
		await screen.findByTestId("boot-button");

		const button = screen.getByTestId("boot-button");
		if (clean !== undefined) bootSelection.choose(clean);
		const removed = waitForElementToBeRemoved(button);
		media?.set((query) => query === WIDE);
		await removed;

		expect(bootSelection.boot).toBe(clean);
	});
});

describe("LogsDialog — the chosen boot lives as long as the open view", () => {
	it("drops the chosen boot when the parent closes the view, telling no store", async () => {
		viewport(false);
		const view = render(LogsDialog, { props: { open: true } });
		await chooseInSheet(BOOT_IDS.clean);
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
		const raw = vi.fn();
		onTestFinished(bootSelection.onChoose(raw));
		const gone = waitForElementToBeRemoved(screen.getByRole("dialog", LOGS));

		await view.rerender({ open: false });
		await gone;

		expect(bootSelection.boot).toBeNull();
		expect(raw).not.toHaveBeenCalled();
	});

	it("drops the chosen boot when the open view is unmounted, telling no store", async () => {
		viewport(false);
		const view = render(LogsDialog, { props: { open: true } });
		await chooseInSheet(BOOT_IDS.clean);
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
		const raw = vi.fn();
		onTestFinished(bootSelection.onChoose(raw));

		view.unmount();

		expect(bootSelection.boot).toBeNull();
		expect(raw).not.toHaveBeenCalled();
	});

	it("reopens on All boots after a parent close, even when the chosen boot is no longer listed", async () => {
		viewport(false);
		const view = render(LogsDialog, { props: { open: true } });
		await chooseInSheet(BOOT_IDS.clean);
		const gone = waitForElementToBeRemoved(screen.getByRole("dialog", LOGS));
		await view.rerender({ open: false });
		await gone;
		rpc.logs.boots.mockResolvedValue(withoutClean());

		await view.rerender({ open: true });

		const button = await screen.findByTestId("boot-button");
		expect(button.textContent).toContain(en.systemLogs.boots.all);
		await fireEvent.click(button);
		const sheet = await screen.findByRole("dialog", SHEET);
		const options = await within(sheet).findAllByRole("option");
		expect(
			options
				.filter((option) => option.getAttribute("aria-selected") === "true")
				.map((option) => option.dataset.testid),
		).toEqual(["boot-option-all"]);
		expect(bootSelection.boot).toBeNull();
	});

	it("goes back to All boots, header included, when deleting history removes the chosen boot", async () => {
		viewport(false);
		render(LogsDialog, { props: { open: true } });
		await chooseInSheet(BOOT_IDS.clean);
		const button = screen.getByTestId("boot-button");
		expect(within(button).queryByText(en.systemLogs.boots.all)).toBeNull();
		const raw = vi.fn();
		onTestFinished(bootSelection.onChoose(raw));
		rpc.logs.boots.mockResolvedValue(withoutClean());

		notifyHistoryChanged();

		await within(button).findByText(en.systemLogs.boots.all);
		expect(bootSelection.boot).toBeNull();
		expect(raw).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("keeps a chosen boot that is still listed after history is deleted", async () => {
		viewport(false);
		render(LogsDialog, { props: { open: true } });
		await chooseInSheet(BOOT_IDS.clean);
		const raw = vi.fn();
		onTestFinished(bootSelection.onChoose(raw));
		rpc.logs.boots.mockClear();

		notifyHistoryChanged();

		expect(rpc.logs.boots).toHaveBeenCalledOnce();
		await rpc.logs.boots.mock.results[0]?.value;
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
		expect(raw).not.toHaveBeenCalled();
	});

	it("stops re-checking once the view is closed", async () => {
		viewport(false);
		const view = render(LogsDialog, { props: { open: true } });
		await screen.findByTestId("boot-button");
		const gone = waitForElementToBeRemoved(screen.getByRole("dialog", LOGS));
		await view.rerender({ open: false });
		await gone;
		const [, clean] = fourBoots();
		if (clean !== undefined) bootSelection.choose(clean);
		rpc.logs.boots.mockClear();

		notifyHistoryChanged();

		expect(rpc.logs.boots).not.toHaveBeenCalled();
	});
});
