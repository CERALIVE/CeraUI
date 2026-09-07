import { spyOn } from "bun:test";
import {
	type StatusResponse,
	statusResponseSchema,
	type UpdatePreflightReason,
} from "@ceraui/rpc";
import * as invariantModule from "../helpers/invariant.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { setup } from "../modules/setup.ts";
import { readArmedStreamMarker } from "../modules/streaming/armed-stream-marker.ts";
import type { AptReachability } from "../modules/system/apt-reachability.ts";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import * as updates from "../modules/system/software-updates.ts";
import * as compat from "../rpc/compat.ts";
import { armedMarkerFixture } from "./software-updates-marker-harness.ts";

export const SPACE_TRANSCRIPT = `After this operation, 2 kB of additional disk space will be used.
'https://repo.invalid/a.deb' a.deb 4000 SHA256:abc
`;

export async function updateHarness() {
	const markerFixture = await armedMarkerFixture();
	const priorEnv = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
	};
	const priorEnabled = setup.apt_update_enabled;
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	setup.apt_update_enabled = true;
	updates.resetSoftwareUpdateState();
	const frames: StatusResponse[] = [];
	let terminal = Promise.withResolvers<void>();
	const originalBroadcast = compat.broadcastMsg;
	const broadcast = spyOn(compat, "broadcastMsg").mockImplementation(
		(type, data) => {
			originalBroadcast(type, data);
			if (type !== "status") return;
			const frame = statusResponseSchema.parse(data);
			frames.push(frame);
			switch (frame.update_state?.kind) {
				case "failed":
				case "success":
				case "update_preflight_failed":
					terminal.resolve();
			}
		},
	);
	const h: {
		failure: UpdatePreflightReason | undefined;
		verdict: AptReachability["verdict"];
		postCleanFails: boolean;
		cleanCount: number;
		free: bigint;
		commands: string[][];
		launches: (readonly string[])[];
		markerAtLaunch: boolean;
		restarts: number;
		beforeClean: (() => Promise<void>) | undefined;
		completion: Promise<number>;
		markerBefore: string;
		frames: StatusResponse[];
	} = {
		failure: undefined,
		verdict: "any",
		postCleanFails: false,
		cleanCount: 0,
		free: 268441456n,
		commands: [],
		launches: [],
		markerAtLaunch: false,
		restarts: 0,
		beforeClean: undefined,
		completion: Promise.resolve(100),
		markerBefore: markerFixture.before,
		frames,
	};
	const run = spyOn(defaultAptSpaceDeps, "run").mockImplementation(
		async (argv) => {
			h.commands.push(argv);
			if (argv.includes("clean")) {
				h.cleanCount++;
				await h.beforeClean?.();
				return {
					exitCode:
						h.failure === "pre_clean_failed" ||
						(h.cleanCount > 1 && h.postCleanFails)
							? 100
							: 0,
					stdout: "",
					stderr: "",
				};
			}
			if (argv[0] === "/usr/bin/apt-config") {
				return {
					exitCode: h.failure === "apt_config_failed" ? 100 : 0,
					stdout:
						h.failure === "archive_path_invalid"
							? "ARCHIVES='relative';"
							: "ARCHIVES='/cache/archives/';",
					stderr: "",
				};
			}
			return {
				exitCode: h.failure === "probe_failed" ? 100 : 0,
				stdout:
					h.failure === "probe_no_uri_rows"
						? ""
						: h.failure === "probe_uri_size_malformed"
							? `${SPACE_TRANSCRIPT}'https://repo.invalid/b.deb' b.deb bad SHA256:def`
							: h.failure === "probe_delta_malformed"
								? SPACE_TRANSCRIPT.replace("After this operation", "unreadable")
								: SPACE_TRANSCRIPT,
				stderr: "",
			};
		},
	);
	const stat = spyOn(defaultAptSpaceDeps, "stat").mockImplementation(
		async () => {
			if (h.failure === "stat_failed") throw new Error("fixture stat failed");
			return { dev: 1n };
		},
	);
	const statfs = spyOn(defaultAptSpaceDeps, "statfs").mockImplementation(
		async () => {
			if (h.failure === "statfs_failed")
				throw new Error("fixture statfs failed");
			return {
				bavail:
					h.failure === "value_out_of_range"
						? -1n
						: h.failure === "insufficient_space"
							? 268441455n
							: h.free,
				bsize: 1n,
			};
		},
	);
	const launch = spyOn(transaction, "runDetachedAptUpgrade").mockImplementation(
		(args, handlers) => {
			h.launches.push(args);
			h.markerAtLaunch =
				readArmedStreamMarker()?.plannedShutdown?.reason === "software_update";
			handlers.onStderr("original transaction failure");
			return h.completion;
		},
	);
	const restart = spyOn(invariantModule, "invariant").mockImplementation(
		(condition, message): asserts condition => {
			if (condition) return;
			if (message === "software update complete; exiting to restart CeraUI") {
				h.restarts++;
				return;
			}
			throw new Error(message);
		},
	);
	updates.setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: h.verdict,
		detail: [],
	}));
	const discovery = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 1,
		stdout:
			"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove.\nNeed to get 4 kB of archives.\n",
		stderr: "",
	});
	await updates.runUpdateDiscoveryAndReport();
	discovery.mockRestore();
	let callback:
		| Parameters<Parameters<typeof updates.setSoftwareUpdateCheckRunner>[0]>[0]
		| undefined;
	updates.setSoftwareUpdateCheckRunner((cb) => {
		callback = cb;
		return true;
	});
	frames.length = 0;
	return Object.assign(h, {
		async check(error: updates.SoftwareUpdateError = null) {
			await callback?.(error, 0);
			await terminal.promise;
		},
		next() {
			terminal = Promise.withResolvers<void>();
			h.cleanCount = 0;
		},
		settled() {
			return terminal.promise;
		},
		marker() {
			return markerFixture.read();
		},
		async [Symbol.asyncDispose]() {
			updates.resetSoftwareUpdateState();
			// Reset retires outcomes, not availability; withdraw the fixture's discovered packages too.
			const emptyDiscovery = spyOn(
				spawnPolicy,
				"spawnWithTimeout",
			).mockResolvedValue({
				exitCode: 0,
				stdout:
					"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
				stderr: "",
			});
			try {
				await updates.runUpdateDiscoveryAndReport();
			} finally {
				emptyDiscovery.mockRestore();
				updates.resetSoftwareUpdateState();
			}
			updates.resetSoftwareUpdateCheckRunner();
			updates.resetAptReachabilityProbeForTest();
			for (const spy of [broadcast, run, stat, statfs, launch, restart])
				spy.mockRestore();
			setup.apt_update_enabled = priorEnabled;
			for (const [key, value] of Object.entries(priorEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await markerFixture[Symbol.asyncDispose]();
		},
	});
}
