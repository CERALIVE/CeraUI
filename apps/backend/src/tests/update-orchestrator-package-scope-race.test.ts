import { afterEach, expect, test } from "bun:test";
import {
	getOrchestratorState,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanScopedFixture,
	movePhase,
	scopedFixture,
} from "./helpers/package-scoped-install.ts";

afterEach(cleanScopedFixture);

const boundaries = [
	"admission",
	"capabilities",
	"pending",
	"settings",
	"metered",
] as const;

test.each(boundaries)(
	"scoped request rechecks phase after awaited %s",
	async (boundary) => {
		// Given an authoritative phase change in each awaited package preparation port.
		const f = scopedFixture({
			isUpdateAdmissionReady: async () => {
				if (boundary === "admission") movePhase("os-available");
				return true;
			},
			loadCapabilities: async () => {
				if (boundary === "capabilities") movePhase("os-available");
				return {
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming"],
				};
			},
			loadSettings: async () => {
				if (boundary === "settings") movePhase("os-available");
				return {
					packagesAuto: true,
					systemAuto: true,
					schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
					channel: "stable",
					allowPackagesOverCellular: true,
					allowSystemOverCellular: true,
				};
			},
			onlyMeteredCandidateExists: async () => {
				if (boundary === "metered") movePhase("os-available");
				return false;
			},
		});
		const save = f.quarantine.savePending.bind(f.quarantine);
		f.quarantine.savePending = async (plan) => {
			await save(plan);
			if (boundary === "pending") movePhase("os-available");
		};
		// When stale package authority resumes.
		const outcome = await installUpdatesNow({ scope: "packages" });
		// Then neither an OS stage nor a package launch can escape the fence.
		expect(outcome).toEqual({ started: false, reason: "not_available" });
		expect(f.stages()).toBe(0);
		expect(f.launches()).toBe(0);
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(await f.quarantine.readPending()).toEqual([]);
	},
);

test.each(boundaries)(
	"scoped request rechecks streaming after awaited %s",
	async (boundary) => {
		// Given a stream which becomes live while package preparation is awaited.
		let live = false;
		const f = scopedFixture({
			isStreamLive: () => live,
			isUpdateAdmissionReady: async () => {
				if (boundary === "admission") live = true;
				return true;
			},
			loadCapabilities: async () => {
				if (boundary === "capabilities") live = true;
				return { mode: "capable", features: ["apt-all-packages"] };
			},
			loadSettings: async () => {
				if (boundary === "settings") live = true;
				return {
					packagesAuto: true,
					systemAuto: true,
					schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
					channel: "stable",
					allowPackagesOverCellular: true,
					allowSystemOverCellular: true,
				};
			},
			onlyMeteredCandidateExists: async () => {
				if (boundary === "metered") live = true;
				return false;
			},
		});
		const save = f.quarantine.savePending.bind(f.quarantine);
		f.quarantine.savePending = async (plan) => {
			await save(plan);
			if (boundary === "pending") live = true;
		};
		// When the scoped action resumes, then it refuses before package dispatch.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "stream_active",
		});
		expect(f.launches()).toBe(0);
		expect(await f.quarantine.readPending()).toEqual([]);
	},
);
