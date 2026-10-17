import {
	ORCHESTRATOR_PHASES,
	type UpdateOrchestratorWireState,
	type UpdateSettings,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	actionRefusalKey,
	appliesAfterRestart,
	etaMinutes,
	familyLabel,
	formatUpdateTime,
	isUpdateBusy,
	isUpdateRefusingStart,
	phaseLabelKey,
	progressPercent,
	scheduleDraftDirty,
	scheduleDraftFrom,
	scheduleErrorKey,
	scheduleFromDraft,
	slotHealthKey,
	slotLetter,
	slotStateKey,
	UPDATE_BUSY_PHASES,
	UPDATE_REFUSING_PHASES,
	updateCapabilityView,
	validateSchedule,
	withSettings,
} from "./update-view";

function wire(
	phase: UpdateOrchestratorWireState["phase"],
	progress: UpdateOrchestratorWireState["progress"] = null,
): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase,
		progress,
		failure_reason: null,
		cellular_override_id: null,
	};
}

const SETTINGS: UpdateSettings = {
	packagesAuto: true,
	systemAuto: true,
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	channel: "stable",
	allowPackagesOverCellular: true,
	allowSystemOverCellular: false,
};

describe("busy and refusing phases", () => {
	it("every refusing phase is also a busy phase", () => {
		for (const phase of UPDATE_REFUSING_PHASES) {
			expect(UPDATE_BUSY_PHASES).toContain(phase);
		}
	});

	it("refuses a start ONLY while dpkg or a service restart runs", () => {
		const refusing = ORCHESTRATOR_PHASES.filter((phase) =>
			isUpdateRefusingStart(wire(phase)),
		);
		expect(refusing).toEqual(["committing", "restarting-services"]);
	});

	it("a short check and the resting phases are not busy", () => {
		for (const phase of [
			"idle",
			"checking",
			"available",
			"settled",
			"synced",
		] as const) {
			expect(isUpdateBusy(wire(phase))).toBe(false);
		}
		expect(isUpdateBusy(wire("os-staging"))).toBe(true);
		expect(isUpdateBusy(wire("syncing"))).toBe(true);
	});

	it("an absent wire state is neither busy nor refusing", () => {
		expect(isUpdateBusy(undefined)).toBe(false);
		expect(isUpdateRefusingStart(null)).toBe(false);
	});

	it("every phase has its own label key", () => {
		const keys = ORCHESTRATOR_PHASES.map(phaseLabelKey);
		expect(new Set(keys).size).toBe(ORCHESTRATOR_PHASES.length);
		for (const key of keys) expect(key).toMatch(/^settings\.updates\.phase\./);
	});

	it("only a staged or armed image applies after restart", () => {
		expect(
			ORCHESTRATOR_PHASES.filter((phase) => appliesAfterRestart(phase)),
		).toEqual(["os-staged", "os-activation-armed"]);
		expect(appliesAfterRestart(undefined)).toBe(false);
	});
});

describe("progress and ETA", () => {
	it("a zero ETA means no estimate, never 0 minutes", () => {
		expect(etaMinutes(0)).toBeUndefined();
		expect(etaMinutes(undefined)).toBeUndefined();
		expect(etaMinutes(null)).toBeUndefined();
		expect(etaMinutes(-5)).toBeUndefined();
	});

	it("rounds a remaining estimate UP to a whole minute", () => {
		expect(etaMinutes(1)).toBe(1);
		expect(etaMinutes(60)).toBe(1);
		expect(etaMinutes(61)).toBe(2);
	});

	it("clamps and rounds a reported percent, and reports none when absent", () => {
		expect(
			progressPercent(wire("downloading", { percent: 41.6, etaSeconds: 0 })),
		).toBe(42);
		expect(progressPercent(wire("downloading"))).toBeUndefined();
		expect(progressPercent(undefined)).toBeUndefined();
	});
});

describe("capability gating", () => {
	it("absent or legacy capabilities gate system and slots off", () => {
		expect(updateCapabilityView(undefined)).toEqual({
			legacy: true,
			system: false,
			slots: false,
		});
		expect(updateCapabilityView({ mode: "legacy", features: [] })).toEqual({
			legacy: true,
			system: false,
			slots: false,
		});
	});

	it("each surface needs its own explicit feature", () => {
		expect(
			updateCapabilityView({ mode: "capable", features: ["apt-all-packages"] }),
		).toEqual({ legacy: false, system: false, slots: false });
		expect(
			updateCapabilityView({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
			}),
		).toEqual({ legacy: false, system: true, slots: true });
	});
});

describe("schedule window validation", () => {
	const draft = (start: string, end: string, crossesMidnight = false) => ({
		mode: "window" as const,
		start,
		end,
		crossesMidnight,
	});

	it("an ordinary daytime window is valid", () => {
		expect(validateSchedule(draft("03:00", "05:00"))).toBeUndefined();
	});

	it("end before start WITHOUT the midnight flag is refused", () => {
		expect(validateSchedule(draft("23:00", "02:00"))).toBe("end-before-start");
	});

	it("end before start WITH the midnight flag is accepted", () => {
		expect(validateSchedule(draft("23:00", "02:00", true))).toBeUndefined();
	});

	it("a flag that contradicts the times is refused", () => {
		expect(validateSchedule(draft("03:00", "05:00", true))).toBe(
			"contradictory-crossing",
		);
	});

	it("a zero-length window never matches, so it is refused", () => {
		expect(validateSchedule(draft("04:00", "04:00"))).toBe("same-time");
		expect(validateSchedule(draft("04:00", "04:00", true))).toBe("same-time");
	});

	it("a malformed time is refused", () => {
		expect(validateSchedule(draft("4:00", "05:00"))).toBe("invalid-time");
		expect(validateSchedule(draft("24:00", "05:00"))).toBe("invalid-time");
	});

	it("any-idle ignores the times entirely", () => {
		expect(
			validateSchedule({
				mode: "any-idle",
				start: "04:00",
				end: "04:00",
				crossesMidnight: false,
			}),
		).toBeUndefined();
	});

	it("every error has a distinct key", () => {
		const keys = (
			[
				"invalid-time",
				"same-time",
				"end-before-start",
				"contradictory-crossing",
			] as const
		).map(scheduleErrorKey);
		expect(new Set(keys).size).toBe(4);
	});

	it("an applied overnight window seeds the flag on", () => {
		expect(
			scheduleDraftFrom({ mode: "window", start: "23:00", end: "02:00" })
				.crossesMidnight,
		).toBe(true);
		expect(
			scheduleDraftFrom({ mode: "window", start: "03:00", end: "05:00" })
				.crossesMidnight,
		).toBe(false);
	});

	it("the saved schedule carries no UI-only flag", () => {
		expect(scheduleFromDraft(draft("23:00", "02:00", true))).toEqual({
			mode: "window",
			start: "23:00",
			end: "02:00",
		});
	});

	it("dirtiness compares the three wire fields only", () => {
		const applied = SETTINGS.schedule;
		expect(scheduleDraftDirty(scheduleDraftFrom(applied), applied)).toBe(false);
		expect(
			scheduleDraftDirty(
				{ ...scheduleDraftFrom(applied), end: "06:00" },
				applied,
			),
		).toBe(true);
	});
});

describe("settings writes", () => {
	it("a single change keeps every other field of the complete input", () => {
		expect(withSettings(SETTINGS, { channel: "beta" })).toEqual({
			...SETTINGS,
			channel: "beta",
		});
	});

	it("the schedule is copied, never shared with the source", () => {
		const next = withSettings(SETTINGS, {});
		expect(next.schedule).toEqual(SETTINGS.schedule);
		expect(next.schedule).not.toBe(SETTINGS.schedule);
	});
});

describe("labels", () => {
	it("a known refusal gets its own sentence, anything else the generic one", () => {
		expect(actionRefusalKey("stream_active")).toBe(
			"settings.updates.refusal.streamActive",
		);
		expect(actionRefusalKey("something_new")).toBe(
			"settings.updates.refusal.generic",
		);
		expect(actionRefusalKey(undefined)).toBe(
			"settings.updates.refusal.generic",
		);
	});

	it("slot state and health", () => {
		expect(slotStateKey("booted")).toBe("settings.updates.slots.running");
		expect(slotStateKey("inactive")).toBe("settings.updates.slots.standby");
		expect(slotStateKey("weird")).toBe("settings.updates.slots.stateUnknown");
		expect(slotHealthKey("good")).toBe("settings.updates.slots.healthy");
		expect(slotHealthKey("bad")).toBe("settings.updates.slots.bad");
		expect(slotHealthKey(null)).toBeUndefined();
		expect(slotLetter({ name: "rootfs.0", bootname: "A" })).toBe("A");
		expect(slotLetter({ name: "rootfs.1", bootname: null })).toBe("rootfs.1");
	});

	it("families are protocol names", () => {
		expect(familyLabel(4)).toBe("IPv4");
		expect(familyLabel(6)).toBe("IPv6");
	});

	it("an unusable timestamp formats to nothing", () => {
		expect(formatUpdateTime(null, "en")).toBeUndefined();
		expect(formatUpdateTime("not a date", "en")).toBeUndefined();
		expect(formatUpdateTime(Date.UTC(2026, 8, 24, 12), "en")).toMatch(/2026/);
	});
});
