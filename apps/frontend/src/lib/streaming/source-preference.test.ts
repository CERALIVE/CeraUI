import type { CaptureDevice } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveFailover,
	deriveSourceState,
	failoverKey,
	normalizeOrder,
	orderByPreference,
	reorderSource,
	videoSources,
} from "./source-preference";

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

const HDMI = vid("video0");
const USB = vid("video1", { kind: "usb" });
const NET = vid("video2", { kind: "network" });
const AUDIO: CaptureDevice = {
	input_id: "audio0",
	device_path: "alsa:audio0",
	display_name: "USB audio",
	media_class: "audio",
	kind: "audio",
};

describe("reorderSource", () => {
	const order = ["a", "b", "c"];

	it("moves an item up by one slot", () => {
		expect(reorderSource(order, "b", "up")).toEqual(["b", "a", "c"]);
	});

	it("moves an item down by one slot", () => {
		expect(reorderSource(order, "b", "down")).toEqual(["a", "c", "b"]);
	});

	it("clamps at the top edge (up on first is a no-op)", () => {
		expect(reorderSource(order, "a", "up")).toEqual(["a", "b", "c"]);
	});

	it("clamps at the bottom edge (down on last is a no-op)", () => {
		expect(reorderSource(order, "c", "down")).toEqual(["a", "b", "c"]);
	});

	it("is a no-op for an unknown id", () => {
		expect(reorderSource(order, "z", "up")).toEqual(["a", "b", "c"]);
	});

	it("never mutates the input array", () => {
		const input = ["a", "b", "c"];
		reorderSource(input, "a", "down");
		expect(input).toEqual(["a", "b", "c"]);
	});

	it("round-trips up then down back to the original order", () => {
		const moved = reorderSource(order, "c", "up");
		expect(reorderSource(moved, "c", "down")).toEqual(order);
	});
});

describe("videoSources / normalizeOrder / orderByPreference", () => {
	const devices = [HDMI, USB, AUDIO, NET];

	it("filters to video media class only", () => {
		expect(videoSources(devices).map((d) => d.input_id)).toEqual([
			"video0",
			"video1",
			"video2",
		]);
	});

	it("keeps persisted order, drops stale ids, appends newcomers", () => {
		const persisted = ["video2", "ghost", "video0"];
		expect(normalizeOrder(devices, persisted)).toEqual([
			"video2",
			"video0",
			"video1",
		]);
	});

	it("falls back to device order when no preference is persisted", () => {
		expect(normalizeOrder(devices, undefined)).toEqual([
			"video0",
			"video1",
			"video2",
		]);
	});

	it("orders devices by the preference list, unranked last", () => {
		const ordered = orderByPreference(devices, ["video2", "video0"]);
		expect(ordered.map((d) => d.input_id)).toEqual([
			"video2",
			"video0",
			"video1",
		]);
	});
});

describe("deriveSourceState", () => {
	it("flags a lost source even when it is the active one", () => {
		expect(deriveSourceState("video0", "video0", true, null)).toBe("lost");
	});

	it("flags the failover target as failed-over", () => {
		const failover = {
			from: "video0",
			to: "video1",
			reason: "source_lost" as const,
		};
		expect(deriveSourceState("video1", "video1", false, failover)).toBe(
			"failed-over",
		);
	});

	it("flags the active source when there is no failover", () => {
		expect(deriveSourceState("video0", "video0", false, null)).toBe("active");
	});

	it("leaves a non-active, non-lost source idle", () => {
		expect(deriveSourceState("video1", "video0", false, null)).toBe("idle");
	});
});

describe("deriveFailover", () => {
	const order = ["video0", "video1"];

	it("returns null when the active source is the top preference", () => {
		expect(deriveFailover(order, [HDMI, USB], "video0")).toBeNull();
	});

	it("returns null when the top preference is still present (manual switch)", () => {
		expect(deriveFailover(order, [HDMI, USB], "video1")).toBeNull();
	});

	it("detects a sticky failover when the top preference is lost", () => {
		const lostHdmi = vid("video0", { lost: true });
		expect(deriveFailover(order, [lostHdmi, USB], "video1")).toEqual({
			from: "video0",
			to: "video1",
			reason: "source_lost",
		});
	});

	it("detects a failover when the top preference vanished entirely", () => {
		expect(deriveFailover(order, [USB], "video1")).toEqual({
			from: "video0",
			to: "video1",
			reason: "source_lost",
		});
	});

	it("returns null when there is no active input", () => {
		expect(deriveFailover(order, [HDMI, USB], undefined)).toBeNull();
	});
});

describe("failoverKey", () => {
	it("is stable for the same transition (drives single-toast dedup)", () => {
		const event = {
			from: "video0",
			to: "video1",
			reason: "source_lost" as const,
		};
		expect(failoverKey(event)).toBe(failoverKey({ ...event }));
	});

	it("differs for a different destination", () => {
		const a = failoverKey({
			from: "video0",
			to: "video1",
			reason: "source_lost",
		});
		const b = failoverKey({
			from: "video0",
			to: "video2",
			reason: "source_lost",
		});
		expect(a).not.toBe(b);
	});
});
