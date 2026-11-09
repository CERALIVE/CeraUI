// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";

import HardwareSwitcher from "./hardware-switcher.svelte";

vi.mock("$lib/rpc", () => ({
	getIsConnected: () => true,
	rpc: {
		streaming: {
			getMockHardware: vi.fn().mockResolvedValue({
				hardware: null,
				effectiveHardware: "generic",
				availableHardware: [],
			}),
		},
	},
}));

it("names the hardware combobox from its visible profile label", async () => {
	const { container } = render(HardwareSwitcher);

	expect(
		await screen.findByRole("combobox", { name: "Select Hardware Profile" }),
	).toBe(container.querySelector('[data-slot="select-trigger"]'));
});
