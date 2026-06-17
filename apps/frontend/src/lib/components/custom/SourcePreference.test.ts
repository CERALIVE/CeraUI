// @vitest-environment jsdom
/**
 * SourcePreference — operator-ordered source preference + fallback state (Task 11).
 *
 * Covers the two behaviours the plan locks: up/down reordering fires the parent
 * callback with the right (id, direction), and a derived sticky-failover raises
 * exactly ONE non-blocking toast carrying the reason — never a modal/confirm.
 */
import type { CaptureDevice } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { destroyDirtyRegistry } from "$lib/rpc/dirty-registry.svelte";
import {
	destroyFieldSyncState,
	getFieldState,
} from "$lib/rpc/field-sync-state.svelte";
import type { FailoverEvent } from "$lib/streaming/source-preference";

import SourcePreference from "./SourcePreference.svelte";

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: {
		warning: toastWarning,
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
		dismiss: vi.fn(),
	},
}));

function vid(
	input_id: string,
	overrides: Partial<CaptureDevice> = {},
): CaptureDevice {
	return {
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: input_id.toUpperCase(),
		media_class: "video",
		kind: "hdmi",
		...overrides,
	};
}

const HDMI = vid("video0", { display_name: "HDMI Cam" });
const USB = vid("video1", { display_name: "USB Cam", kind: "usb" });

beforeEach(() => {
	getFieldState("__warmup__");
	toastWarning.mockReset();
});

afterEach(() => {
	destroyFieldSyncState();
	destroyDirtyRegistry();
});

describe("SourcePreference — reorder controls", () => {
	it("renders sources in preference order with rank numbers", () => {
		const { container } = render(SourcePreference, {
			props: {
				devices: [HDMI, USB],
				order: ["video1", "video0"],
				activeInput: "video1",
			},
		});
		const rows = [...container.querySelectorAll("[data-input-id]")];
		expect(rows.map((r) => r.getAttribute("data-input-id"))).toEqual([
			"video1",
			"video0",
		]);
	});

	it("fires onReorder('video1','up') when the up button is clicked", async () => {
		const onReorder = vi.fn();
		const { container } = render(SourcePreference, {
			props: { devices: [HDMI, USB], order: ["video0", "video1"], onReorder },
		});
		const up = container.querySelector<HTMLButtonElement>(
			'[data-move-up="video1"]',
		);
		if (!up) throw new Error("up button not rendered");
		await fireEvent.click(up);
		expect(onReorder).toHaveBeenCalledWith("video1", "up");
	});

	it("fires onReorder('video0','down') when the down button is clicked", async () => {
		const onReorder = vi.fn();
		const { container } = render(SourcePreference, {
			props: { devices: [HDMI, USB], order: ["video0", "video1"], onReorder },
		});
		const down = container.querySelector<HTMLButtonElement>(
			'[data-move-down="video0"]',
		);
		if (!down) throw new Error("down button not rendered");
		await fireEvent.click(down);
		expect(onReorder).toHaveBeenCalledWith("video0", "down");
	});

	it("disables up on the first row and down on the last row", () => {
		const { container } = render(SourcePreference, {
			props: { devices: [HDMI, USB], order: ["video0", "video1"] },
		});
		expect(
			container
				.querySelector('[data-move-up="video0"]')
				?.hasAttribute("disabled"),
		).toBe(true);
		expect(
			container
				.querySelector('[data-move-down="video1"]')
				?.hasAttribute("disabled"),
		).toBe(true);
	});

	it("renders the 44px touch-safe reorder buttons (size-11)", () => {
		const { container } = render(SourcePreference, {
			props: { devices: [HDMI, USB], order: ["video0", "video1"] },
		});
		const up = container.querySelector('[data-move-up="video1"]');
		expect(up?.className).toContain("size-11");
	});
});

describe("SourcePreference — fallback state badges", () => {
	it("marks the active source active and a lost source lost", () => {
		const { container } = render(SourcePreference, {
			props: {
				devices: [HDMI, vid("video1", { display_name: "USB Cam", lost: true })],
				order: ["video0", "video1"],
				activeInput: "video0",
			},
		});
		expect(
			container
				.querySelector('[data-input-id="video0"]')
				?.getAttribute("data-state"),
		).toBe("active");
		expect(
			container
				.querySelector('[data-input-id="video1"]')
				?.getAttribute("data-state"),
		).toBe("lost");
	});

	it("marks the failover target failed-over", () => {
		const failover: FailoverEvent = {
			from: "video0",
			to: "video1",
			reason: "source_lost",
		};
		const { container } = render(SourcePreference, {
			props: {
				devices: [vid("video0", { lost: true }), USB],
				order: ["video0", "video1"],
				activeInput: "video1",
				failover,
			},
		});
		expect(
			container
				.querySelector('[data-input-id="video1"]')
				?.getAttribute("data-state"),
		).toBe("failed-over");
	});
});

describe("SourcePreference — sticky-failover toast", () => {
	it("raises exactly one non-blocking toast carrying the reason", () => {
		const failover: FailoverEvent = {
			from: "video0",
			to: "video1",
			reason: "source_lost",
		};
		render(SourcePreference, {
			props: {
				devices: [vid("video0", { display_name: "HDMI Cam", lost: true }), USB],
				order: ["video0", "video1"],
				activeInput: "video1",
				failover,
			},
		});
		flushSync();
		expect(toastWarning).toHaveBeenCalledTimes(1);
		const [, options] = toastWarning.mock.calls[0] as [
			string,
			{ description: string },
		];
		// The reason surfaces the source that went offline.
		expect(options.description).toContain("HDMI Cam");
	});

	it("does not toast when there is no failover", () => {
		render(SourcePreference, {
			props: {
				devices: [HDMI, USB],
				order: ["video0", "video1"],
				activeInput: "video0",
				failover: null,
			},
		});
		flushSync();
		expect(toastWarning).not.toHaveBeenCalled();
	});
});
