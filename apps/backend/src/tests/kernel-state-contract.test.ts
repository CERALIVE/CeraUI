import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultKernelEffects } from "../modules/system/update-orchestrator/kernel-runtime.ts";
import {
	acknowledgeKernelState,
	readKernelState,
	readSlotOverlay,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	parseInstalledImage,
	readInstalledImage,
} from "../modules/system/update-orchestrator/os-installed-image.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import captured from "./fixtures/real-device/rock-admission-20261009.json";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

useSessionOwnerForFile();
afterEach(resetOrchestratorRuntimeForTest);
const fixtureRoot = new URL(
	"./fixtures/kernel-state-contract/",
	import.meta.url,
);
const stdout =
	captured.commands["rauc status --detailed --output-format=json"].stdout;

async function contractFixture(outcome: "staged" | "failed") {
	const directory = await mkdtemp(join(tmpdir(), "kernel-agreed-contract-"));
	const arms: boolean[] = [];
	let installs = 0;
	await writeFile(
		join(directory, "kernel-state.json"),
		await readFile(new URL(`${outcome}-state.json`, fixtureRoot)),
	);
	await writeFile(
		join(directory, "slot-overlay-B.json"),
		await readFile(
			new URL(
				`${outcome === "staged" ? "pending" : "invalid"}-overlay.json`,
				fixtureRoot,
			),
		),
	);
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			now: () => Date.parse("2026-10-20T00:02:00Z"),
			loadSettings: async () => ({
				packagesAuto: false,
				systemAuto: false,
				channel: "stable",
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
			}),
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "kernel-apt-stage"],
			}),
			isUpdateAdmissionReady: async () => true,
			readRootSlots: async () => [
				{
					name: "rootfs.0",
					bootname: "A",
					state: "booted",
					bootStatus: "good",
					version: "2026.10.0",
					lastSyncedAt: null,
				},
				{
					name: "rootfs.1",
					bootname: "B",
					state: "inactive",
					bootStatus: "good",
					version: "2026.10.0",
					lastSyncedAt: null,
				},
			],
			kernel: {
				...defaultKernelEffects,
				discover: async () => null,
				readState: () => readKernelState(directory),
				readOverlay: (slot) => readSlotOverlay(slot, directory),
				readBooted: async () => ({
					package: "linux-image-7.2.0-ceralive-rk3588",
					version: "7.2.0-ceralive1",
				}),
				launch: async () => {
					installs++;
				},
				arm: async (now) => {
					arms.push(now);
				},
				acknowledge: (attempt) => acknowledgeKernelState(attempt, directory),
				notify: () => true,
			},
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "kernel-staging",
	});
	return {
		directory,
		arms,
		installs: () => installs,
		[Symbol.asyncDispose]: () =>
			rm(directory, { recursive: true, force: true }),
	};
}

describe("agreed producer contract fixtures (not producer output)", () => {
	test("staged state parses A/B slots and its retained staged clock, then reconciles without reinstalling", async () => {
		await using fixture = await contractFixture("staged");
		const state = await readKernelState(fixture.directory);
		expect(state).toMatchObject({
			state: "staged",
			target_slot: "B",
			booted_slot_at_stage: "A",
			reason: null,
			timestamps: { staged: "2026-10-20T00:01:00Z" },
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("kernel-staged");
		expect(fixture.arms).toEqual([false]);
		expect(fixture.installs()).toBe(0);
	});
	test("pending overlay parses actual RAUC byte identity for both roles and permits matching staged reconciliation", async () => {
		await using fixture = await contractFixture("staged");
		const overlay = await readSlotOverlay("B", fixture.directory);
		if (overlay?.status !== "pending")
			throw new Error("pending fixture required");
		expect(overlay.reason).toBeNull();
		const booted = parseInstalledImage(stdout, "booted");
		expect(overlay.base_bundle_identity).toEqual(booted?.identity);
		for (const role of ["booted", "inactive"] as const) {
			const image = parseInstalledImage(stdout, role, overlay);
			expect(image?.identity.kernelOverlay).toEqual({
				...overlay.kernel,
				attempt: overlay.attempt,
				status: "pending",
			});
		}
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("kernel-staged");
		expect(fixture.arms).toEqual([false]);
	});
	test("invalid overlay parses its lean envelope, stays unknown and never arms through failed reconciliation", async () => {
		await using fixture = await contractFixture("failed");
		const overlay = await readSlotOverlay("B", fixture.directory);
		expect(overlay).toEqual({
			status: "invalid",
			attempt: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			reason: "kernel_staging",
		});
		for (const role of ["booted", "inactive"] as const)
			expect(parseInstalledImage(stdout, role, overlay)).toBeNull();
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "kernel-failed",
			failureReason: "kernel_staging_failed",
		});
		expect(fixture.arms).toEqual([]);
		expect(fixture.installs()).toBe(0);
	});
	test("failed state parses a named reason and acknowledges without deleting invalid overlay evidence", async () => {
		await using fixture = await contractFixture("failed");
		expect(await readKernelState(fixture.directory)).toMatchObject({
			state: "failed",
			reason: "kernel_staging_failed",
			timestamps: { failed: "2026-10-20T00:00:05Z" },
		});
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect((await readKernelState(fixture.directory))?.acknowledged).toBe(true);
		expect((await readSlotOverlay("B", fixture.directory))?.status).toBe(
			"invalid",
		);
		expect(
			await readInstalledImage("inactive", {
				directory: fixture.directory,
				run: async () => ({ exitCode: 0, stdout, stderr: "" }),
			}),
		).toBeNull();
		expect(fixture.arms).toEqual([]);
	});
	test.each([
		["rootfs.N target", { target_slot: "rootfs.1" }],
		["rootfs.N booted slot", { booted_slot_at_stage: "rootfs.0" }],
		["empty reason", { reason: "" }],
		["prose reason", { reason: "rsync mirror failed (rc=23)" }],
	])(
		"rejects the old %s state shape before reconciliation can arm or install",
		async (_name, patch) => {
			await using fixture = await contractFixture("staged");
			const state = await readKernelState(fixture.directory);
			await writeFile(
				join(fixture.directory, "kernel-state.json"),
				JSON.stringify({ ...state, ...patch }),
			);
			await expect(readKernelState(fixture.directory)).rejects.toThrow();
			await expect(runOrchestratorTick()).rejects.toThrow();
			expect(fixture.arms).toEqual([]);
			expect(fixture.installs()).toBe(0);
		},
	);
	test.each([
		["base null", { base_bundle_identity: null }],
		["kernel null", { kernel: null }],
		["both null keys", { base_bundle_identity: null, kernel: null }],
	])(
		"rejects the old invalid overlay with %s before reconciliation can arm or install",
		async (_name, patch) => {
			await using fixture = await contractFixture("failed");
			const overlay = await readSlotOverlay("B", fixture.directory);
			await writeFile(
				join(fixture.directory, "slot-overlay-B.json"),
				JSON.stringify({ ...overlay, ...patch }),
			);
			await expect(readSlotOverlay("B", fixture.directory)).rejects.toThrow();
			await expect(runOrchestratorTick()).rejects.toThrow();
			expect(fixture.arms).toEqual([]);
			expect(fixture.installs()).toBe(0);
		},
	);
	test.each([
		["staged", ""],
		["staged", "rsync mirror failed (rc=23)"],
		["failed", ""],
		["failed", "rsync mirror failed (rc=23)"],
	] as const)(
		"rejects %s overlay with a non-token reason %j",
		async (outcome, reason) => {
			await using fixture = await contractFixture(outcome);
			const overlay = await readSlotOverlay("B", fixture.directory);
			await writeFile(
				join(fixture.directory, "slot-overlay-B.json"),
				JSON.stringify({ ...overlay, reason }),
			);
			await expect(readSlotOverlay("B", fixture.directory)).rejects.toThrow();
			await expect(runOrchestratorTick()).rejects.toThrow();
			expect(fixture.arms).toEqual([]);
			expect(fixture.installs()).toBe(0);
		},
	);
});
