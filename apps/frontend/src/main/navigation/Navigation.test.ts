import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNavigation } from "../../lib/stores/navigation.svelte.ts";
import MainNav from "./MainNav.svelte";
import MobileNav from "./MobileNav.svelte";

vi.mock(
	"$main/LiveView.svelte",
	() => import("../../tests/fixtures/Noop.svelte"),
);
vi.mock(
	"$main/NetworkView.svelte",
	() => import("../../tests/fixtures/Noop.svelte"),
);
vi.mock(
	"$main/SettingsView.svelte",
	() => import("../../tests/fixtures/Noop.svelte"),
);
vi.mock(
	"$main/tabs/DevTools.svelte",
	() => import("../../tests/fixtures/Noop.svelte"),
);
vi.mock(
	"$main/tabs/IdentityPreview.svelte",
	() => import("../../tests/fixtures/Noop.svelte"),
);

beforeEach(() => {
	resetNavigation();
	vi.spyOn(window, "matchMedia").mockReturnValue({
		...window.matchMedia(""),
		matches: true,
	});
	// Keep successive clicks in one clock tick instead of relying on machine speed.
	vi.spyOn(Date, "now").mockReturnValue(1000);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([
	["desktop rail", MainNav],
	["mobile dock", MobileNav],
] as const)("%s navigation (#418)", (_layout, Navigation) => {
	it("accepts successive destinations without waiting for wall-clock time", async () => {
		render(Navigation);

		for (const name of ["Network", "Settings", "Live"]) {
			const tab = screen.getByRole("button", { name });
			await fireEvent.click(tab);
			expect(tab.getAttribute("aria-current")).toBe("page");
		}
	});
});
