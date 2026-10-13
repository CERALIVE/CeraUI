// @vitest-environment jsdom
/**
 * A failed `addons.list()` says nothing about the device's add-on inventory
 * (round-3 review C, minor): it renders "could not be read" with a retry,
 * never "No add-ons available".
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import AddonsSection from "./AddonsSection.svelte";

const rpcMocks = vi.hoisted(() => ({
	list: vi.fn(),
	getMockHardware: vi.fn(),
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		addons: { list: rpcMocks.list, install: vi.fn(), uninstall: vi.fn() },
		streaming: { getMockHardware: rpcMocks.getMockHardware },
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({ getAddons: () => ({}) }));
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

afterEach(() => {
	destroyAsyncOperations();
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

describe("AddonsSection: a failed list read", () => {
	it("renders unavailable with retry, never the empty inventory", async () => {
		// Given a device whose add-on list cannot be read.
		rpcMocks.list.mockRejectedValueOnce(new Error("Request timeout"));
		rpcMocks.getMockHardware.mockResolvedValue({
			hardware: null,
			effectiveHardware: "n100",
			availableHardware: ["n100"],
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		// When the section opens.
		render(AddonsSection, { props: { open: true } });

		// Then it says the list could not be read, and offers a retry.
		const band = await screen.findByTestId("addons-list-failed");
		expect(band.getAttribute("role")).toBe("status");
		expect(screen.queryByTestId("addons-empty")).toBeNull();
		expect(document.body.textContent).not.toContain("No add-ons available");

		// When the retry succeeds with an empty image.
		rpcMocks.list.mockResolvedValueOnce({ addons: [] });
		const retry = band.querySelector("button");
		if (!retry) throw new Error("retry missing");
		await fireEvent.click(retry);

		// Then the empty inventory is now a fact the device reported.
		await waitFor(() =>
			expect(screen.queryByTestId("addons-empty")).not.toBeNull(),
		);
		expect(screen.queryByTestId("addons-list-failed")).toBeNull();
	});
});
