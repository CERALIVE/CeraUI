import { describe, expect, it, mock } from "bun:test";
import type { SessionSwitchTarget } from "@ceralive/cerastream";
import {
	type SessionSwitchDeps,
	switchSessionInput,
} from "../modules/streaming/session-switch.ts";

const targets: SessionSwitchTarget[] = [
	{ input_id: "/dev/video0", kind: "capture" },
	{ input_id: "b", kind: "synthetic" },
];

function fixture(roster = targets) {
	const legacySwitch = mock(async () => ({ success: false }));
	const switchTarget = mock(async (id: string) => ({
		active_input: id,
		mode: "manual" as const,
	}));
	const captureFollow = mock(
		(_id: string, result: { success: boolean }) => result,
	);
	const deps: SessionSwitchDeps = {
		isStreaming: () => true,
		listTargets: async () => ({ switch_targets: roster }),
		legacySwitch,
		switchTarget,
		captureFollow,
		now: () => 0,
	};
	return { deps, legacySwitch, switchTarget, captureFollow };
}

describe("session namespace admission", () => {
	it("refuses a stale synthetic target without claiming a physical unplug", async () => {
		// Given: the displayed snapshot contained b, but the fresh graph no longer does.
		const f = fixture(targets.filter((target) => target.input_id !== "b"));
		// When: the operator submits the stale selector's synthetic id.
		const result = await switchSessionInput("b", f.deps);
		// Then: non-admission is neutral and cannot change capture or audio state.
		expect(result).toEqual({ success: false, error: "SWITCH_FAILED" });
		expect(f.switchTarget).not.toHaveBeenCalled();
		expect(f.legacySwitch).not.toHaveBeenCalled();
		expect(f.captureFollow).not.toHaveBeenCalled();
	});
	it("switches SMPTE without discovery, persistence or audio follow", async () => {
		const f = fixture();
		expect(await switchSessionInput("b", f.deps)).toEqual({
			success: true,
			active_input: "b",
			gap_ms: 0,
		});
		expect(f.switchTarget).toHaveBeenCalledWith("b");
		expect(f.legacySwitch).not.toHaveBeenCalled();
		expect(f.captureFollow).not.toHaveBeenCalled();
	});
	it("returns to the admitted capture and retains its durable follow", async () => {
		const f = fixture();
		await switchSessionInput("/dev/video0", f.deps);
		expect(f.switchTarget).toHaveBeenCalledWith("/dev/video0");
		expect(f.captureFollow).toHaveBeenCalledTimes(1);
		expect(f.legacySwitch).not.toHaveBeenCalled();
	});
	it.each(["test", "missing", "b"])(
		"rejects absent %s without legacy fallback",
		async (id) => {
			const f = fixture([]);
			expect((await switchSessionInput(id, f.deps)).success).toBe(false);
			expect(f.switchTarget).not.toHaveBeenCalled();
			expect(f.legacySwitch).not.toHaveBeenCalled();
		},
	);
	it("does not turn an empty authoritative roster into discovered targets", async () => {
		const f = fixture([]);
		expect((await switchSessionInput("b", f.deps)).success).toBe(false);
		expect(f.legacySwitch).not.toHaveBeenCalled();
	});
	it("retains legacy device admission only when the query is unsupported", async () => {
		const f = fixture();
		await switchSessionInput("b", {
			...f.deps,
			listTargets: async () => undefined,
		});
		expect(f.legacySwitch).toHaveBeenCalledWith("b");
		expect(f.switchTarget).not.toHaveBeenCalled();
	});
	it("does not retry through discovery after an engine refusal", async () => {
		const f = fixture();
		await expect(
			switchSessionInput("b", {
				...f.deps,
				switchTarget: async () => {
					throw new Error("session ended");
				},
			}),
		).rejects.toThrow("session ended");
		expect(f.legacySwitch).not.toHaveBeenCalled();
	});
});
