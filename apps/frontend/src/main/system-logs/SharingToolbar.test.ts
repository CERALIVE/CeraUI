// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type {
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";

import { de, en } from "../../tests/helpers/catalog";

import SharingToolbar from "./SharingToolbar.svelte";

const createExport =
	vi.fn<(input: LogExportInput) => Promise<LogExportOutput>>();
const previewBundle = vi.fn<() => Promise<LogBundleManifest>>();
const createBundle = vi.fn<() => Promise<LogExportOutput>>();
let flow: SharingFlow;

beforeEach(() => {
	createExport.mockReset();
	previewBundle.mockReset();
	createBundle.mockReset();
	previewBundle.mockReturnValue(new Promise<never>(() => {}));
	flow = new SharingFlow({
		logs: { createExport, previewBundle, createBundle },
		download: vi.fn(),
	});
	render(SharingToolbar, { props: { sharing: flow } });
});

afterEach(() => {
	cleanup();
	flow.dispose();
	setLocale("en");
	vi.restoreAllMocks();
});

const sharing = en.systemLogs.sharing;

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("SharingToolbar: the logs toolbar's sharing actions", () => {
	it("offers Support bundle, then Export logs, as one group named like the Downloads region", () => {
		const group = screen.getByRole("group", { name: sharing.heading });
		expect(group.dataset.testid).toBe("sharing-toolbar");
		expect(
			within(group)
				.getAllByRole("button")
				.map((action) => [
					action.dataset.testid,
					action.textContent?.trim(),
					action.dataset.variant,
				]),
		).toEqual([
			["sharing-toolbar-bundle", sharing.bundle, "outline"],
			["sharing-toolbar-export", sharing.exportLogs, "default"],
		]);
	});

	// Lime fills only the view's one primary sharing action (DESIGN.md IH-5).
	it.each([
		[
			"sharing-toolbar-bundle",
			"lucide-life-buoy",
			"border-border",
			"bg-primary",
		],
		[
			"sharing-toolbar-export",
			"lucide-download",
			"bg-primary",
			"border-border",
		],
	] as const)(
		"draws %s with its decorative glyph and its own fill",
		(id, glyph, fill, otherFill) => {
			const action = screen.getByTestId(id);
			expect(action.dataset.slot).toBe("button");
			expect(tokens(action)).toContain(fill);
			expect(tokens(action)).not.toContain(otherFill);
			const icon = action.querySelector("svg");
			expect(icon?.getAttribute("aria-hidden")).toBe("true");
			expect(tokens(icon)).toEqual(expect.arrayContaining([glyph, "size-4"]));
		},
	);

	it("moves a button that does not fit to its own row, wraps a label longer than a row, and leaves the 44 px lift to the touch layer", () => {
		const group = screen.getByTestId("sharing-toolbar");
		// Below 640 px a phone is thumbed, so the group takes the touch target there (app.css).
		expect(group.hasAttribute("data-touch-region")).toBe(true);
		expect(tokens(group)).toContain("flex-wrap");
		for (const action of within(group).getAllByRole("button")) {
			expect(tokens(action)).toEqual(
				expect.arrayContaining(["h-auto", "max-w-full", "whitespace-normal"]),
			);
			// Shrinking below its longest word would paint that word outside the button.
			expect(tokens(action)).not.toContain("min-w-0");
			expect(tokens(action)).not.toContain("whitespace-nowrap");
			// A min-height utility would outrank the touch layer's 44 px lift (TT-1).
			expect(
				tokens(action).filter((token) => token.startsWith("min-h-")),
			).toEqual([]);
		}
	});

	// A label that wraps keeps its words whole: Japanese breaks at phrases, Korean at
	// spaces, Chinese only where its copy marks a word gap (C5 at 320 px).
	it("breaks a long label only between Japanese phrases, Korean words or marked Chinese words", async () => {
		expect(tokens(screen.getByTestId("sharing-toolbar"))).toEqual(
			expect.arrayContaining([
				"[word-break:auto-phrase]",
				"[&:lang(ko)]:break-keep",
				"[&:lang(zh)]:break-keep",
				"wrap-break-word",
			]),
		);
		setLocale("zh");
		await tick();
		expect(
			screen.getByTestId("sharing-toolbar-export").querySelectorAll("wbr")
				.length,
		).toBeGreaterThan(0);
	});

	it("opens the export confirmation and the bundle preview through the view's flow, downloading nothing", async () => {
		await fireEvent.click(screen.getByTestId("sharing-toolbar-export"));
		expect(flow.exportStep).toBe("confirm");
		expect(createExport).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId("sharing-toolbar-bundle"));
		expect(flow.bundleStep).toBe("previewing");
		expect(previewBundle).toHaveBeenCalledTimes(1);
		expect(createBundle).not.toHaveBeenCalled();
	});

	it("renders both labels in the active locale", async () => {
		setLocale("de");
		await tick();
		expect(
			screen.getByTestId("sharing-toolbar-bundle").textContent?.trim(),
		).toBe(de.systemLogs.sharing.bundle);
		expect(
			screen.getByTestId("sharing-toolbar-export").textContent?.trim(),
		).toBe(de.systemLogs.sharing.exportLogs);
		expect(
			screen.getByRole("group", { name: de.systemLogs.sharing.heading }),
		).toBeTruthy();
	});
});
