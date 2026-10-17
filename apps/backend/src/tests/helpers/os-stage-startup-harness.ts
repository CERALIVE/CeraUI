import type { OsStageJobRecord } from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import type { OsStartupDeps } from "../../modules/system/update-orchestrator/os-stage-startup.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const record: OsStageJobRecord = {
	schema: 1,
	attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	candidateKey: "candidate",
	bundleUrl: "https://images.ceralive.tv/releases/fixture/bundle.raucb",
	baseline: {
		instance: "659:10",
		active: true,
		operation: "idle",
		processes: ["659:10"],
		resources: [],
		bootId: "boot-B",
		bootPrimary: "rootfs.1",
		bootedSlot: "rootfs.1",
		bootedDevice: "179:5",
		bootedHealthy: true,
		targetSlot: "rootfs.0",
		targetDevice: "179:4",
		targetInactive: true,
		activationArmed: false,
	},
	processes: ["659:10"],
	resources: ["mount:51"],
	launched: true,
	cliSettled: false,
	requireNewInstance: true,
};

export function harness() {
	const calls: string[] = [];
	let now = 0;
	const deps: OsStartupDeps = {
		acquireControl: acquireTestOsStageControl,
		readJob: async () => record,
		run: async () => ({
			exitCode: 0,
			stdout: "LoadState=loaded\n",
			stderr: "",
		}),
		owner: () => ({
			acquire: async () => {
				// Startup adopts the already-held fixture owner.
			},
			held: async () => true,
			beginAttempt: () => {
				// Startup never launches a replacement installer.
			},
			record: () => record,
			remember: () => {
				calls.push("settled");
			},
			release: async () => {
				calls.push("release");
			},
		}),
		observe: async () =>
			now < 315000
				? {
						...record.baseline,
						active: false,
						operation: null,
						resources: ["mount:51"],
					}
				: {
						...record.baseline,
						instance: "371279:99",
						processes: ["371279:99"],
					},
		cliGone: async () => now >= 315000,
		restart: async () => {
			calls.push("restart-submission");
		},
		sweep: async () => {
			calls.push("sweep");
		},
		drain: async () => {
			calls.push("drain");
		},
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	};
	return { deps, calls, now: () => now };
}
