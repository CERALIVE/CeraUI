// @vitest-environment jsdom
import InfoIcon from "@lucide/svelte/icons/info";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../../tests/helpers/media-query";

import AppDialog from "./AppDialog.svelte";

const body = createRawSnippet(() => ({
	render: () => '<p data-testid="dialog-body-content">Body</p>',
}));
const aside = createRawSnippet(() => ({
	render: () => '<span data-testid="dialog-aside">Idle</span>',
}));

let media: MediaQueryControl | undefined;

function viewport(desktop: boolean): void {
	media = installMediaQueries(() => desktop);
}

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
});

function surface(): HTMLElement {
	const dialog = screen.getByRole("dialog");
	return dialog;
}

function bodyRegion(): HTMLElement {
	const content = screen.getByTestId("dialog-body-content");
	const region = content.parentElement;
	if (!region) throw new Error("body content has no region");
	return region;
}

function classes(element: Element): string[] {
	return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("AppDialog: default surface (fullscreen omitted)", () => {
	it("keeps the centered dialog with its height cap and padded scrolling body on desktop", () => {
		viewport(true);
		render(AppDialog, {
			props: { open: true, title: "Settings entry", children: body },
		});

		const dialog = surface();
		expect(dialog.dataset.slot).toBe("dialog-content");
		expect(classes(dialog)).toEqual(
			expect.arrayContaining(["max-h-[85svh]", "sm:max-w-lg", "rounded-xl"]),
		);
		expect(dialog.getAttribute("style") ?? "").not.toContain("translate");
		expect(bodyRegion().className).toBe(
			"min-h-0 flex-1 overflow-y-auto px-5 py-4",
		);
	});

	it("keeps the bottom sheet on narrow screens", () => {
		viewport(false);
		render(AppDialog, {
			props: { open: true, title: "Settings entry", children: body },
		});

		const dialog = surface();
		expect(dialog.dataset.slot).toBe("sheet-content");
		expect(classes(dialog)).toEqual(
			expect.arrayContaining(["max-h-[85svh]", "rounded-t-2xl"]),
		);
		expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
	});

	it("keeps the title anatomy and draws the icon only when one is given", () => {
		viewport(true);
		render(AppDialog, {
			props: {
				open: true,
				title: "Settings entry",
				children: body,
				icon: InfoIcon,
			},
		});

		const title = screen.getByRole("heading", { name: "Settings entry" });
		expect(classes(title)).toEqual(
			expect.arrayContaining([
				"flex",
				"items-center",
				"gap-2.5",
				"text-base",
				"leading-tight",
				"font-semibold",
			]),
		);
		expect(classes(title.querySelector("svg") as Element)).toEqual(
			expect.arrayContaining(["text-primary", "size-5", "shrink-0"]),
		);
		expect(title.querySelector("span")?.getAttribute("class")).toBe(
			"min-w-0 truncate",
		);
		cleanup();

		render(AppDialog, {
			props: { open: true, title: "Settings entry", children: body },
		});
		expect(
			screen
				.getByRole("heading", { name: "Settings entry" })
				.querySelector("svg"),
		).toBeNull();
	});

	it("renders the title directly in the header when there is no aside", () => {
		viewport(true);
		render(AppDialog, {
			props: { open: true, title: "Settings entry", children: body },
		});

		const title = screen.getByRole("heading", { name: "Settings entry" });
		expect(title.parentElement?.hasAttribute("data-app-dialog-header")).toBe(
			true,
		);
	});
});

describe("AppDialog: fullscreen", () => {
	it.each([true, false])(
		"uses the centered dialog pinned to every edge at desktop=%s",
		(desktop) => {
			viewport(desktop);
			render(AppDialog, {
				props: {
					open: true,
					fullscreen: true,
					title: "System Logs",
					children: body,
				},
			});

			const dialog = surface();
			expect(dialog.dataset.slot).toBe("dialog-content");
			expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
			const surfaceClasses = classes(dialog);
			expect(dialog.getAttribute("style")).toContain("translate: none");
			expect(surfaceClasses).toEqual(
				expect.arrayContaining([
					"fixed",
					"inset-0",
					"w-full",
					"max-w-none",
					"sm:max-w-none",
					"rounded-none",
					"ring-0",
				]),
			);
			for (const capped of [
				"max-h-[85svh]",
				"sm:max-w-lg",
				"sm:max-w-sm",
				"max-w-[calc(100%-2rem)]",
				"rounded-xl",
				"top-1/2",
				"left-1/2",
				"ring-1",
			]) {
				expect(surfaceClasses).not.toContain(capped);
			}
		},
	);

	it.each([
		[true, true],
		[false, true],
		[false, false],
	])(
		"marks the page for the gutter rule only when fullscreen (fullscreen=%s, desktop=%s)",
		(fullscreen, desktop) => {
			viewport(desktop);
			render(AppDialog, {
				props: {
					open: true,
					fullscreen,
					title: "Settings entry",
					children: body,
				},
			});

			expect(surface().hasAttribute("data-app-dialog-fullscreen")).toBe(
				fullscreen,
			);
		},
	);

	it("gives the body to its children: no padding, no scroll of its own", () => {
		viewport(true);
		render(AppDialog, {
			props: {
				open: true,
				fullscreen: true,
				title: "System Logs",
				children: body,
			},
		});

		expect(bodyRegion().className).toBe("flex min-h-0 flex-1 flex-col");
	});

	it("keeps the header and the close button unchanged", async () => {
		viewport(false);
		render(AppDialog, {
			props: {
				open: true,
				fullscreen: true,
				title: "System Logs",
				children: body,
			},
		});

		expect(screen.getByRole("dialog", { name: "System Logs" })).toBeTruthy();
		const close = screen.getByTestId("app-dialog-close");
		expect(close.getAttribute("aria-label")).toBe(en.dialogs.close);
		expect(close.dataset.touchTarget).toBe("hit-area");
		expect(close.closest("[data-app-dialog-header]")).not.toBeNull();

		await fireEvent.click(close);
		await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
	});

	it("merges contentClass onto the fullscreen surface", () => {
		viewport(true);
		render(AppDialog, {
			props: {
				open: true,
				fullscreen: true,
				title: "System Logs",
				children: body,
				contentClass: "probe-class",
			},
		});

		expect(classes(surface())).toContain("probe-class");
	});
});

describe("AppDialog: header aside", () => {
	it.each([true, false])(
		"renders the aside beside the title, outside it, so the name stays the title (fullscreen=%s)",
		(fullscreen) => {
			viewport(true);
			render(AppDialog, {
				props: {
					open: true,
					fullscreen,
					title: "System Logs",
					children: body,
					headerAside: aside,
				},
			});

			expect(screen.getByRole("dialog", { name: "System Logs" })).toBeTruthy();
			const title = screen.getByRole("heading", { name: "System Logs" });
			const asideNode = screen.getByTestId("dialog-aside");
			expect(title.contains(asideNode)).toBe(false);
			const row = title.parentElement;
			expect(row?.contains(asideNode)).toBe(true);
			expect(row?.hasAttribute("data-app-dialog-header")).toBe(false);
			expect(classes(row as Element)).toEqual(
				expect.arrayContaining(["flex", "flex-wrap", "items-center"]),
			);
			expect(row?.parentElement?.hasAttribute("data-app-dialog-header")).toBe(
				true,
			);
			const end = asideNode.parentElement as HTMLElement;
			expect(end.parentElement).toBe(row);
			expect(classes(end)).toEqual(
				expect.arrayContaining(["ms-auto", "flex", "items-center"]),
			);
		},
	);
});
