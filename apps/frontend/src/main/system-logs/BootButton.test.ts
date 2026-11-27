// @vitest-environment jsdom

import { setLocale } from "@ceraui/i18n/svelte";
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitForElementToBeRemoved,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { BOOT_IDS, fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { formatBootTime } from "$lib/device-logs/boot-rows";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { RpcError } from "$lib/rpc/rpc-error";

import { en } from "../../tests/helpers/catalog";

import BootButton from "./BootButton.svelte";

const boots = vi.hoisted(() => vi.fn<() => Promise<LogBootInfo[]>>());
const rpc = vi.hoisted(
	() => ({ logs: { boots } }) as { logs?: { boots: typeof boots } },
);
const ensureNamespaces = vi.hoisted(() =>
	vi.fn<(namespaces: readonly string[]) => Promise<void>>(),
);
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock(
	"@ceraui/i18n/svelte",
	async (
		importOriginal: () => Promise<typeof import("@ceraui/i18n/svelte")>,
	) => ({
		...(await importOriginal()),
		ensureNamespaces,
	}),
);

beforeAll(() => {
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	rpc.logs = { boots };
	boots.mockReset();
	boots.mockResolvedValue(fourBoots());
	ensureNamespaces.mockReset();
	ensureNamespaces.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	bootSelection.reset();
	setLocale("en");
	vi.restoreAllMocks();
});

const [current, clean] = fourBoots();

function button(): Promise<HTMLElement> {
	return screen.findByTestId("boot-button");
}

// Every reply here is already settled, so a bounded microtask drain lets the
// button finish deciding; no timer is involved.
async function settled(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
	await tick();
}

describe("BootButton: when it appears", () => {
	it("appears once the view's copy loaded and the device answered the boot list", async () => {
		render(BootButton);

		expect(screen.queryByTestId("boot-button")).toBeNull();
		expect(await button()).toBeTruthy();
		expect(ensureNamespaces).toHaveBeenCalledExactlyOnceWith([
			"systemLogs",
			"timeline",
		]);
		expect(boots).toHaveBeenCalledTimes(1);
	});

	it("still appears when the first read failed for another reason, so the sheet can retry", async () => {
		boots.mockRejectedValueOnce(
			new RpcError({
				message: "Request timeout: logs.boots",
				code: "INTERNAL_ERROR",
			}),
		);
		render(BootButton);

		expect(await button()).toBeTruthy();
	});

	it("never appears on a device version without the boot list", async () => {
		boots.mockRejectedValue(
			new RpcError({
				message: "Unknown procedure path: logs.boots",
				code: "INTERNAL_ERROR",
			}),
		);
		render(BootButton);
		await settled();

		expect(screen.queryByTestId("boot-button")).toBeNull();
	});

	it("never appears for a client without the logs procedures", async () => {
		rpc.logs = undefined;
		render(BootButton);
		await settled();

		expect(ensureNamespaces).toHaveBeenCalled();
		expect(screen.queryByTestId("boot-button")).toBeNull();
	});

	it("stays hidden and reports it when the view's copy cannot load", async () => {
		const failure = new Error("chunk fetch failed");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		ensureNamespaces.mockRejectedValueOnce(failure);
		render(BootButton);
		await settled();

		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs boot picker could not load its copy:",
			failure,
		);
		expect(screen.queryByTestId("boot-button")).toBeNull();
	});
});

describe("BootButton: label", () => {
	it("is named by the boot field followed by the boot it shows", async () => {
		render(BootButton);
		const node = await button();

		expect(
			screen.getByRole("button", {
				name: `${en.systemLogs.boots.open} ${en.systemLogs.boots.all}`,
			}),
		).toBe(node);
		expect(node.textContent?.trim()).toBe(en.systemLogs.boots.all);
	});

	it("reads This boot for the running boot", async () => {
		if (current !== undefined) bootSelection.choose(current);
		render(BootButton);
		const node = await button();

		expect(node.textContent?.trim()).toBe(en.systemLogs.boots.current);
		expect(
			screen.getByRole("button", {
				name: [en.systemLogs.boots.open, en.systemLogs.boots.current].join(" "),
				exact: true,
			}),
		).toBe(node);
	});

	it("reads the start time of an earlier boot, and follows the selection", async () => {
		render(BootButton);
		const node = await button();

		if (clean !== undefined) bootSelection.choose(clean);
		await tick();

		const started = en.systemLogs.boots.started.replace(
			"{time}",
			formatBootTime(clean?.firstTs ?? 0, "en"),
		);
		expect(node.textContent?.trim()).toBe(started);
		expect(screen.getByRole("button", { name: started, exact: true })).toBe(
			node,
		);

		bootSelection.reset();
		await tick();
		expect(
			screen.getByRole("button", {
				name: [en.systemLogs.boots.open, en.systemLogs.boots.all].join(" "),
				exact: true,
			}),
		).toBe(node);
	});

	it("isolates the start time in a bdi and formats it in the operator's locale", async () => {
		setLocale("de");
		if (clean !== undefined) bootSelection.choose(clean);
		render(BootButton);

		const isolated = (await button()).querySelectorAll("bdi");
		expect([...isolated].map((node) => node.textContent)).toEqual([
			formatBootTime(clean?.firstTs ?? 0, "de"),
		]);
	});

	it("is a small outline button that reaches the touch target and wraps a long label instead of overflowing", async () => {
		render(BootButton);
		const node = await button();

		const classes = node.className.split(/\s+/);
		expect(classes).toEqual(
			expect.arrayContaining([
				"border-border",
				"h-auto",
				"min-h-7",
				"max-w-full",
				"gap-1.5",
				"min-w-0",
				"shrink",
				"whitespace-normal",
				"text-start",
				"text-pretty",
				"text-[0.8rem]",
			]),
		);
		expect(classes).not.toContain("shrink-0");
		expect(classes).not.toContain("whitespace-nowrap");
		expect(classes).not.toContain("h-7");
		expect(node.dataset.touchTarget).toBe("hit-area");
		const chevron = node.querySelector("svg");
		expect(chevron?.getAttribute("aria-hidden")).toBe("true");
		expect(chevron?.getAttribute("class")?.split(/\s+/)).toEqual(
			expect.arrayContaining(["size-4", "shrink-0"]),
		);
		expect(node.querySelector(".truncate")).toBeNull();
	});

	it("is positioned, so its touch hit area stays on the button instead of covering the dialog header", async () => {
		render(BootButton);
		const node = await button();

		expect(node.dataset.touchTarget).toBe("hit-area");
		expect(node.className.split(/\s+/)).toContain("relative");
	});

	it("keeps its end clear of the dialog's close button, so their touch hit areas stay 8 px apart", async () => {
		render(BootButton);
		const node = await button();

		expect(node.className.split(/\s+/)).toContain("me-1");
	});

	it("keeps its touch hit area off the title when the header wraps it onto its own row", async () => {
		render(BootButton);
		const node = await button();

		expect(node.className.split(/\s+/)).toContain("my-0.5");
	});

	it("keeps its label's words and a timestamp's tokens whole in every language, so 오전 or 16日 never splits", async () => {
		render(BootButton);
		const node = await button();

		const label = node.querySelector(":scope > span");
		expect(label?.className.split(/\s+/)).toContain("break-keep");
	});

	it("keeps its accessible name outside the visible label", async () => {
		render(BootButton);
		const node = await button();

		const [nameId, labelId] = (
			node.getAttribute("aria-labelledby") ?? ""
		).split(" ");
		const name = document.getElementById(nameId ?? "");
		expect(name?.hidden).toBe(true);
		expect(name?.textContent).toBe(en.systemLogs.boots.open);
		expect(node.contains(name)).toBe(false);
		expect(document.getElementById(labelId ?? "")?.parentElement).toBe(node);
	});
});

describe("BootButton: the boot sheet", () => {
	it("opens a sheet titled Boots that lists the boots, with no footer", async () => {
		render(BootButton);
		const node = await button();
		expect(screen.queryByRole("dialog")).toBeNull();

		await fireEvent.click(node);

		const sheet = await screen.findByRole("dialog", {
			name: en.systemLogs.boots.heading,
		});
		expect(sheet.querySelector("[data-app-dialog-footer]")).toBeNull();
		expect(
			within(sheet).getByRole("listbox", { name: en.systemLogs.boots.heading }),
		).toBeTruthy();
		expect(await within(sheet).findAllByTestId("boot-option")).toHaveLength(4);
	});

	it("closes the sheet when a boot is chosen and shows that boot", async () => {
		render(BootButton);
		await fireEvent.click(await button());
		const sheet = await screen.findByRole("dialog");
		const [, cleanOption] = await within(sheet).findAllByTestId("boot-option");

		const removed = waitForElementToBeRemoved(sheet);
		if (cleanOption !== undefined) await fireEvent.click(cleanOption);

		await removed;
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
		expect((await button()).textContent).toContain(
			formatBootTime(clean?.firstTs ?? 0, "en"),
		);
	});

	it("opens the sheet again after Escape closed it", async () => {
		render(BootButton);
		await fireEvent.click(await button());
		const first = await screen.findByRole("dialog");
		const removed = waitForElementToBeRemoved(first);
		await fireEvent.keyDown(first, { key: "Escape" });
		await removed;

		await fireEvent.click(await button());

		expect(
			await screen.findByRole("dialog", { name: en.systemLogs.boots.heading }),
		).toBeTruthy();
	});

	it("closes the sheet with Escape and keeps the boot", async () => {
		if (clean !== undefined) bootSelection.choose(clean);
		render(BootButton);
		await fireEvent.click(await button());
		const sheet = await screen.findByRole("dialog");
		const removed = waitForElementToBeRemoved(sheet);

		await fireEvent.keyDown(sheet, { key: "Escape" });

		await removed;
		expect(bootSelection.bootId).toBe(BOOT_IDS.clean);
	});
});
