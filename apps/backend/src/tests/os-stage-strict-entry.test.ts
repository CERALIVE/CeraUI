import { afterEach, expect, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import {
	setOsStageEntryDepsForTest,
	stageOsBundle,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { OsAgentError } from "../modules/system/update-orchestrator/os-identity.ts";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { strictStageIo } from "./helpers/os-stage-strict-io.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const offered = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.51",
	serial: 13,
	published_at: "2026-10-01T00:00:00Z",
	expires_at: "2026-12-01T00:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/bundle.raucb",
		size: 1,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/flash.raw.xz",
		size: 1,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url: "https://images.ceralive.tv/releases/packages.lock.json",
});
afterEach(() => setOsStageEntryDepsForTest(null));

test.each([
	["current", "downgrade_or_same"],
	["replayed-newer", "serial_replayed"],
	["expired", "expired"],
	["quarantined", "version_quarantined"],
	["still-admitted", null],
] as const)(
	"real stage entry handles %s through fresh strict admission",
	async (kind, reason) => {
		// Given a previously offered pointer and a different fresh admission context.
		const pointer =
			kind === "expired"
				? { ...offered, expires_at: "2026-10-01T00:00:00Z" }
				: offered;
		const booted = kind === "current" ? offered.version : "2026.10.50";
		let reads = 0;
		let raucCalls = 0;
		setOsStageEntryDepsForTest({
			settings: async () => ({
				packagesAuto: false,
				systemAuto: true,
				channel: "stable",
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
			}),
			readSigned: async () => {
				reads++;
				return {
					data: new TextEncoder().encode(JSON.stringify(pointer)),
					signature: new Uint8Array([1]),
					context: {
						board: offered.board,
						compatible: offered.compatible,
						channel: offered.channel,
						serial: kind === "replayed-newer" ? offered.serial : 12,
						bootedVersion: booted,
						installedVersion: "2026.9.3",
						now: Date.parse("2026-10-02T00:00:00Z"),
					},
					verification: {
						verifyCms: async () => ({
							cn: "CeraLive OTA Manifest Signer",
							eku: ["codeSigning"],
							issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
						}),
						compare: async (left, right) => left > right,
						isQuarantined: async () => kind === "quarantined",
					},
				};
			},
			board: async () => ({
				board: offered.board,
				compatible: offered.compatible,
			}),
			booted: async () => booted,
			compare: async (left, right) => left > right,
			runJob: async () => {
				raucCalls++;
				return {
					schema: 1,
					version: offered.version,
					channel: offered.channel,
					stagedAt: 0,
					bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				};
			},
		});
		// When the actual production stage entry freshly admits the offer.
		const outcome = await stageOsBundle(offered, () => {}).then(
			() => null,
			(error: unknown) => error,
		);
		// Then strict refusal reaches the caller and no RAUC job can be dispatched.
		expect(reads).toBe(1);
		if (reason === null) {
			expect(outcome).toBeNull();
			expect(raucCalls).toBe(1);
			return;
		}
		expect(outcome).toBeInstanceOf(OsStageError);
		if (!(outcome instanceof OsStageError))
			throw new Error("stage must refuse");
		expect(outcome.cause).toBeInstanceOf(OsAgentError);
		if (!(outcome.cause instanceof OsAgentError))
			throw new Error("strict refusal cause missing");
		expect(outcome.cause.reason).toBe(reason);
		expect(raucCalls).toBe(0);
	},
);

test("real job refuses an expired replacement pointer after entry admission before installing", async () => {
	// Given valid entry admission and private files for all fixed device reads.
	await using io = await strictStageIo(offered);
	let installs = 0;
	const snapshot = {
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
	};
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse(await Bun.file(io.capabilities).json()),
		now: () => 0,
		run: async () => "default dev eth0\n",
	});
	await pin.sweep();
	setOsStageEntryDepsForTest({
		settings: async () => ({
			packagesAuto: false,
			systemAuto: true,
			channel: "stable",
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			allowPackagesOverCellular: false,
			allowSystemOverCellular: false,
		}),
		readSigned: async () => ({
			data: new TextEncoder().encode(JSON.stringify(offered)),
			signature: new Uint8Array([1]),
			context: {
				board: offered.board,
				compatible: offered.compatible,
				channel: "stable",
				serial: 12,
				bootedVersion: "2026.10.50",
				installedVersion: "2026.9.3",
				now: Date.parse("2026-10-02T00:00:00Z"),
			},
			verification: {
				verifyCms: async () => ({
					cn: "CeraLive OTA Manifest Signer",
					eku: ["codeSigning"],
					issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
				}),
				compare: async (left, right) => left > right,
				isQuarantined: async () => false,
			},
		}),
		board: async () => ({
			board: offered.board,
			compatible: offered.compatible,
		}),
		booted: async () => "2026.10.50",
		compare: async (left, right) => left > right,
		runJob: (manifest, control, deps) => {
			io.expire();
			return runOsStageJob(manifest, control, {
				...deps,
				acquireControl: acquireTestOsStageControl,
				pin,
				observe: async () => snapshot,
				blocked: async () => false,
				selection: async () =>
					rankTransports([
						{
							candidate: { ifname: "eth0", kind: "ethernet", metered: false },
							family: 4,
							hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
						},
					]),
				owner: (record) => ({
					record: () => record,
					acquire: async () => {},
					held: async () => true,
					remember: () => {},
					beginAttempt: () => {},
					release: async () => {},
				}),
				attempt: () => {
					installs++;
					throw new Error("installer reached after expiry");
				},
				prepareReceipt: async () => {
					throw new Error("receipt reached after expiry");
				},
			});
		},
	});
	// When entry dispatches its actual job and that job re-reads the changed pointer.
	const outcome = await stageOsBundle(offered, () => {}).then(
		() => null,
		(error: unknown) => error,
	);
	// Then strict per-pair admission refuses before any installer or receipt effect.
	expect(installs).toBe(0);
	expect(io.downloads()).toBe(2);
	expect(outcome).toBeInstanceOf(OsStageError);
	if (!(outcome instanceof OsStageError))
		throw new Error("stage refusal missing");
	expect(outcome.cause).toBeInstanceOf(OsAgentError);
	if (!(outcome.cause instanceof OsAgentError))
		throw new Error("strict refusal missing");
	expect(outcome.cause.reason).toBe("expired");
});
