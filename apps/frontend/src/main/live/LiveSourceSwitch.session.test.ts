import type { ActiveEncode, StreamSource } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import LiveSourceSwitch from "./LiveSourceSwitch.svelte";

const capture: StreamSource = {
	origin: "capture",
	id: "hdmi",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "HDMI",
	devicePath: "/dev/video0",
	modes: [],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "none",
	available: true,
};
const sources = {
	hardware: "rk3588",
	sources: [capture, { ...capture, id: "usb", displayName: "USB" }],
};
const encode: ActiveEncode = {
	active_input: "hdmi",
	codec: "h264",
	resolution: "1920x1080",
	framerate: 30,
};

describe("published session roster", () => {
	it.each(["passthrough", "composition"])(
		"shows explicit no-target truth for %s instead of discovery actions",
		(mode) => {
			// Given: both graph kinds publish the same authoritative empty roster.
			const activeEncode = {
				...encode,
				passthrough: mode === "passthrough",
				switch_targets: [],
			};
			// When: two discovered cameras coexist with a leg-less session.
			render(LiveSourceSwitch, { sources, activeEncode });
			// Then: no control promises a switch and the known-empty state is stated.
			expect(screen.queryAllByRole("button")).toHaveLength(0);
			expect(screen.getByTestId("live-switch-roster-state").dataset.state).toBe(
				"empty",
			);
			expect(screen.getByRole("status").textContent).toBe(
				"No source switches are available in this session.",
			);
		},
	);

	it("distinguishes an absent roster from an empty one while retaining legacy capture admission", () => {
		// Given: a legacy encode snapshot has no switch_targets property.
		// When: the live capture surface renders it.
		render(LiveSourceSwitch, { sources, activeEncode: encode });
		// Then: the old guarded action remains, qualified as unknown session truth.
		expect(screen.getByRole("button", { name: "Switch – USB" })).toBeDefined();
		expect(screen.getByTestId("live-switch-roster-state").dataset.state).toBe(
			"unknown",
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Live switch targets are not reported by this engine.",
		);
	});

	it("renders only the published roster and does not let discovery withdraw a built leg", async () => {
		// Given: discovery is stale, but the engine still owns a linked capture leg.
		const onSwitch = vi.fn();
		const activeEncode: ActiveEncode = {
			...encode,
			active_input: "b",
			switch_targets: [
				{ input_id: "hdmi", kind: "capture" },
				{ input_id: "b", kind: "synthetic" },
			],
		};
		// When: the operator returns from the synthetic leg to capture.
		render(LiveSourceSwitch, {
			sources: {
				...sources,
				sources: [{ ...capture, lost: true, available: false }],
			},
			activeEncode,
			onSwitch,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Switch – HDMI" }),
		);
		// Then: membership wins; idle-only USB is never offered.
		expect(onSwitch).toHaveBeenCalledExactlyOnceWith("hdmi");
		expect(screen.queryByRole("button", { name: "Switch – USB" })).toBeNull();
		expect(screen.getByTestId("source-selected-b")).toBeDefined();
	});
});
