// @vitest-environment jsdom
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import SystemLogsView from "./SystemLogsView.svelte";

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: vi.fn<() => Promise<unknown>>(),
		boots: vi.fn<() => Promise<LogBootInfo[]>>(),
	},
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;

beforeEach(() => {
	rpc.logs.getStorage.mockReset();
	rpc.logs.getStorage.mockResolvedValue({});
	rpc.logs.boots.mockReset();
	rpc.logs.boots.mockResolvedValue(fourBoots());
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	bootSelection.reset();
});

describe("SystemLogsView: Boots region", () => {
	it("lists the boots under the Boots heading of the side column at 1024 px and wider", async () => {
		media = installMediaQueries((query) => query === WIDE);
		render(SystemLogsView);

		const region = await screen.findByRole("region", {
			name: en.systemLogs.boots.heading,
		});
		expect(region.dataset.testid).toBe("system-logs-boots");
		const listbox = await within(region).findByRole("listbox", {
			name: en.systemLogs.boots.heading,
		});
		expect(within(listbox).getAllByTestId("boot-option")).toHaveLength(4);
		expect(region.querySelector("h3 + *")?.getAttribute("data-testid")).toBe(
			"boot-picker",
		);
		expect(rpc.logs.boots).toHaveBeenCalledTimes(1);
	});

	it("reads no boots below 1024 px, where the header button owns the picker", async () => {
		media = installMediaQueries(() => false);
		render(SystemLogsView);
		await screen.findByRole("tablist");

		expect(screen.queryByTestId("boot-picker")).toBeNull();
		expect(rpc.logs.boots).not.toHaveBeenCalled();
	});
});
