// @vitest-environment jsdom
import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";

import {
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const scan = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: { configure: vi.fn(), setUsbMode: vi.fn(), scan, getSms: vi.fn() },
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function modem(
	generation = 1,
	phase: "completed" | "scanning" = "completed",
): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 70,
			roaming: true,
		},
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: true,
			network: "",
			autoconfig: true,
		},
		available_networks: {
			"00101": { name: "Carrier", availability: "available" },
		},
		network_scan: { generation, phase },
	};
}

function mount(value: Modem) {
	publishModems({ "7": value });
	return render(ModemConfigDialog, {
		props: { open: true, modem: value, deviceId: "7" },
	});
}

beforeAll(() => {
	if (!Element.prototype.animate) {
		Element.prototype.animate = vi.fn().mockReturnValue({
			cancel: vi.fn(),
			finish: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}) as unknown as Element["animate"];
	}
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
	}
});

beforeEach(() => {
	resetModemsFeed();
	destroyAsyncOperations();
	scan.mockReset();
});

afterEach(() => {
	destroyAsyncOperations();
	(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
		undefined;
});

describe("explicit modem scan lifecycle", () => {
	it("finishes when the result set is unchanged but a newer completion arrives", async () => {
		scan.mockResolvedValue({ success: true, scanGeneration: 2 });
		const view = mount(modem());

		await fireEvent.click(screen.getByTestId("modem-scan-button"));
		expect(screen.getByTestId("modem-scanning-state")).toBeDefined();

		const completed = modem(2);
		publishModems({ "7": completed });
		await view.rerender({ open: true, modem: completed, deviceId: "7" });
		await waitFor(() =>
			expect(screen.queryByTestId("modem-scanning-state")).toBeNull(),
		);
		expect(screen.queryByTestId("modem-scan-unconfirmed")).toBeNull();
	});

	it("renders an unknown outcome when no terminal lifecycle frame arrives", async () => {
		(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
			30;
		scan.mockResolvedValue({ success: true, scanGeneration: 2 });
		mount(modem());

		await fireEvent.click(screen.getByTestId("modem-scan-button"));
		await waitFor(
			() => expect(screen.getByTestId("modem-scan-unconfirmed")).toBeDefined(),
			{ timeout: 4_000 },
		);
		expect(screen.queryByTestId("modem-scanning-state")).toBeNull();
	});

	it("renders an already-running refusal instead of dropping it", async () => {
		scan.mockResolvedValue({ success: false, scanFailure: "already_scanning" });
		mount(modem());

		await fireEvent.click(screen.getByTestId("modem-scan-button"));
		const band = await screen.findByTestId("modem-scan-error");
		expect(band.getAttribute("data-scan-failure")).toBe("already_scanning");
	});
});
