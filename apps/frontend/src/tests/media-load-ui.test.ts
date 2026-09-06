// @vitest-environment jsdom
import type { EncoderLoad } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import EncoderStatus from "$lib/components/custom/EncoderStatus.svelte";
import MediaLoadDialog from "../main/dialogs/MediaLoadDialog.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsConnected: () => true,
}));
vi.mock("$lib/stores/device-health-history.svelte", () => ({
	acquireHealthClock: () => () => {},
	getHealthClockTick: () => 1234,
}));

const reading: EncoderLoad = {
	source: null,
	cores: [],
	updatedAt: 1234,
	simulated: true,
	blocks: [
		{
			source: "mpp-service",
			block: "rkvenc",
			cores: [
				{
					core: "fdbd0000.rkvenc-core",
					load: 145.53,
					utilization: 121.08,
					sessions: [
						{ pid: 4242, index: 7 },
						{ pid: 4242, index: 9 },
					],
				},
			],
		},
		{
			source: "mpp-service",
			block: "rkvdec",
			cores: [
				{
					core: "fdc38100.video-codec",
					load: null,
					utilization: 23.1,
					sessions: null,
				},
				{ core: "fdc48100.video-codec", load: 0, utilization: 0, sessions: [] },
			],
		},
		{
			source: "mpp-service",
			block: "jpgdec",
			cores: [
				{ core: "fdba0000.jpegd", load: 7.5, utilization: 5, sessions: [] },
			],
		},
		{
			source: "rkrga",
			block: "rga",
			cores: [
				{
					core: "scheduler[0]: rga3",
					load: 12,
					utilization: null,
					sessions: null,
				},
			],
		},
	],
};

afterEach(cleanup);
beforeAll(() => {
	window.matchMedia = vi.fn(
		(media: string): MediaQueryList => ({
			matches: false,
			media,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: () => true,
		}),
	);
});

describe("media load hint", () => {
	it.each(["panel", "inline"] as const)(
		"shows both raw values and data-derived groups in %s density",
		(density) => {
			render(EncoderStatus, { reading, density });
			const hint = screen.getByTestId("media-load-hint");
			expect(hint.getAttribute("data-core-count")).toBe("5");
			expect(within(hint).getAllByTestId("media-load-group")).toHaveLength(4);
			expect(hint.textContent).toContain("145.53%");
			expect(hint.textContent).toContain("121.08%");
			expect(
				hint.querySelector('[role="progressbar"], [data-marker="rail"]'),
			).toBeNull();
			expect(hint.textContent).not.toContain("4242");
		},
	);

	it("opens full session detail only after the operator asks", async () => {
		render(EncoderStatus, { reading });
		expect(screen.queryByRole("dialog")).toBeNull();
		await fireEvent.click(
			screen.getByRole("button", { name: /media details/i }),
		);
		const dialog = await screen.findByRole("dialog", { name: /media load/i });
		expect(dialog.textContent).toContain("4242");
		expect(dialog.textContent).toContain("7");
		expect(dialog.textContent).toContain("9");
		expect(dialog.textContent).toContain("Unknown");
		expect(dialog.textContent).toContain("No bound sessions");
		expect(dialog.textContent).toContain("Not published by this driver");
		expect(dialog.textContent).toContain("creating task");
	});

	it("retracts retired cores and owners when a new snapshot replaces the old one", async () => {
		const view = render(EncoderStatus, { reading });
		await fireEvent.click(
			screen.getByRole("button", { name: /media details/i }),
		);
		await screen.findByRole("dialog");
		await view.rerender({
			reading: {
				...reading,
				blocks: [
					{
						source: "mpp-service",
						block: "rkvenc",
						cores: [
							{
								core: "replacement-core",
								load: null,
								utilization: null,
								sessions: null,
							},
						],
					},
				],
			},
		});
		expect(screen.getByRole("dialog").textContent).not.toContain("4242");
		expect(screen.getByRole("dialog").textContent).not.toContain("fdbd0000");
		expect(
			screen.getByTestId("media-load-hint").getAttribute("data-core-count"),
		).toBe("1");
	});

	it("keeps clock-only encoding beside independently reported RGA", () => {
		const value: EncoderLoad = {
			...reading,
			source: "clk-enable-count",
			cores: [{ core: "rkvenc0", kind: "active", active: true }],
			blocks: reading.blocks?.filter((group) => group.block === "rga"),
		};
		render(EncoderStatus, { reading: value });
		expect(
			screen.getByTestId("encoder-core-value-rkvenc0").textContent,
		).toContain("Busy");
		expect(
			screen.getByTestId("encoder-core-value-rkvenc0").textContent,
		).not.toMatch(/\d|%/);
		expect(screen.getByTestId("media-load-hint").textContent).toContain(
			"12.00%",
		);
	});

	it("preserves the legacy renderer when blocks is empty", () => {
		render(EncoderStatus, {
			reading: {
				...reading,
				blocks: [],
				source: "clk-enable-count",
				cores: [{ core: "rkvenc0", kind: "active", active: false }],
			},
		});
		expect(screen.queryByTestId("media-load-hint")).toBeNull();
		expect(
			screen.getByTestId("encoder-core-value-rkvenc0").textContent,
		).toContain("Idle");
	});

	it("keeps an open detail dialog honest when the device falls back to clock readings", async () => {
		const view = render(EncoderStatus, { reading });
		await fireEvent.click(
			screen.getByRole("button", { name: /media details/i }),
		);
		await screen.findByRole("dialog");
		await view.rerender({
			reading: {
				source: "clk-enable-count",
				updatedAt: 1234,
				simulated: false,
				cores: [
					{ core: "rkvenc0", kind: "active", active: true },
					{ core: "rkvenc1", kind: "unavailable" },
				],
			},
		});
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByTestId("encoder-core-value-rkvenc0").textContent,
		).toBe("Busy");
		expect(
			within(dialog).getByTestId("encoder-core-value-rkvenc1").textContent,
		).toBe("Unavailable");
		expect(dialog.textContent).not.toContain("4242");
		expect(dialog.textContent).toContain(
			"Utilization and session ownership are unknown",
		);
	});

	it.each([
		{
			source: "mpp-service",
			cores: [{ core: "encoder", kind: "percent", percent: 23 }],
		},
		{
			source: "clk-enable-count",
			cores: [{ core: "encoder", kind: "active", active: false }],
		},
		{ source: null, cores: [] },
	] satisfies Pick<EncoderLoad, "source" | "cores">[])(
		"renders legacy detail for $source without invented ownership",
		(legacy) => {
			render(MediaLoadDialog, {
				open: true,
				reading: { ...legacy, updatedAt: null, simulated: false },
			});
			const dialog = screen.getByRole("dialog");
			expect(within(dialog).queryByTestId("media-detail-group")).toBeNull();
			expect(dialog.textContent).toContain("session ownership are unknown");
			expect(dialog.querySelectorAll("input, select, textarea")).toHaveLength(
				0,
			);
		},
	);

	it("marks an aged sample without blanking its measured values", () => {
		render(EncoderStatus, {
			reading: { ...reading, simulated: false, updatedAt: -10_000 },
		});
		const hint = screen.getByTestId("media-load-hint");
		expect(hint.getAttribute("data-stale")).toBe("true");
		expect(hint.textContent).toContain("Last reading");
		expect(hint.textContent).toContain("145.53%");
	});

	it("shows RGA alone even with no encoder source", () => {
		render(EncoderStatus, {
			reading: {
				...reading,
				blocks: reading.blocks?.filter((group) => group.block === "rga"),
			},
		});
		expect(screen.getByTestId("media-load-hint").textContent).toContain(
			"12.00%",
		);
		expect(
			screen.getByRole("table").querySelectorAll('[data-metric="utilization"]'),
		).toHaveLength(0);
		expect(
			screen
				.getByTestId("encoder-status-headline")
				.getAttribute("data-activity"),
		).toBe("unreported");
	});
});
