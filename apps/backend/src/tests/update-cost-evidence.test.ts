import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { decideCellularGate } from "../modules/system/update-orchestrator/schedule.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { discoverCandidates } from "../modules/system/update-transport/core.ts";
import { defaultUpdateTransportDeps } from "../modules/system/update-transport/executor.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

afterEach(() => {
	mock.restore();
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

const wifi =
	"GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:";

test.each([
	[1, ""],
	[0, "malformed"],
	[0, `${wifi}no\nGENERAL.METERED:unknown`],
	[0, `${wifi}no\nbroken-row`],
	[0, `${wifi}unknown`],
	[0, wifi.replace("\nGENERAL.METERED:", "")],
] as const)(
	"inventory exit=%s payload=%s cannot authorize an OS check",
	async (exitCode, stdout) => {
		// Given no positively established unmetered inventory and both toggles off.
		spyOn(defaultUpdateTransportDeps, "run").mockResolvedValue({
			exitCode,
			stdout,
			stderr: "",
		});
		spyOn(defaultUpdateTransportDeps, "listIfnames").mockReturnValue(["wlan0"]);
		spyOn(defaultUpdateTransportDeps, "mmIfnames").mockReturnValue([]);
		spyOn(defaultUpdateTransportDeps, "routerIfnames").mockReturnValue([]);
		spyOn(defaultUpdateTransportDeps, "dongleIfnames").mockReturnValue([]);
		// When the real default inventory feeds the policy gate.
		const onlyMeteredCandidateExists =
			await defaultOrchestratorRuntimeDeps.onlyMeteredCandidateExists();
		const gate = decideCellularGate({
			onlyMeteredCandidateExists,
			kind: "os",
			stage: "check",
			allowPackagesOverCellular: false,
			allowSystemOverCellular: false,
			cellularOverrideId: null,
			candidateId: "os",
		});
		// Then absence of evidence is not permission.
		expect(gate).toEqual({ allowed: false, needsOverride: false });
	},
);

test("unknown Wi-Fi cost remains unknown internally without a cellular identity guess", () => {
	// Given connected Wi-Fi without cellular markers.
	// When the production inventory parser reads unknown cost.
	const candidates = discoverCandidates(["wlan0"], `${wifi}unknown`, [], []);
	// Then it cannot become a positively unmetered link.
	expect(candidates).toEqual([
		{ ifname: "wlan0", kind: "wifi", metered: null },
	]);
});

test.each(["no", "guess-no", "no (guessed)"])(
	"positively unmetered Wi-Fi (%s) permits a check",
	async (metered) => {
		spyOn(defaultUpdateTransportDeps, "run").mockResolvedValue({
			exitCode: 0,
			stdout: `${wifi}${metered}`,
			stderr: "",
		});
		spyOn(defaultUpdateTransportDeps, "listIfnames").mockReturnValue(["wlan0"]);
		spyOn(defaultUpdateTransportDeps, "mmIfnames").mockReturnValue([]);
		spyOn(defaultUpdateTransportDeps, "routerIfnames").mockReturnValue([]);
		spyOn(defaultUpdateTransportDeps, "dongleIfnames").mockReturnValue([]);
		expect(
			await defaultOrchestratorRuntimeDeps.onlyMeteredCandidateExists(),
		).toBe(false);
	},
);

test.each([false, true])(
	"Ethernet discovery then metered installation obeys current package allowance=%s",
	async (allowed) => {
		// Given a package offer discovered over Ethernet, then only cellular remains.
		let onlyMetered = false;
		let launches = 0;
		const deps = fakeDeps();
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				loadSettings: async () => ({
					...(await deps.loadSettings()),
					allowPackagesOverCellular: allowed,
				}),
				onlyMeteredCandidateExists: async () => onlyMetered,
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "candidate", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [
						{
							name: "cerastream",
							version: "2026.9.6",
							layer: "app",
							actionable: true,
						},
					],
				}),
				startPackageInstall: () => {
					launches++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		onlyMetered = true;
		// When installation is requested after the connection changed.
		const result = await installUpdatesNow();
		// Then the existing refusal vocabulary is retained and no forbidden launch occurs.
		expect(result).toEqual(
			allowed ? { started: true } : { started: false, reason: "busy" },
		);
		expect(launches).toBe(allowed ? 1 : 0);
	},
);
