import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
	setOsStageEntryDepsForTest,
	stageOsBundle,
} from "../modules/system/update-orchestrator/os-agent.ts";
import {
	admitOsKernelIdentity,
	checkPinnedOsKernelAdmission,
	defaultOsKernelAdmissionDeps,
	verifyKernelSidecar,
} from "../modules/system/update-orchestrator/os-kernel-admission.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	kernelOverlay,
	kernelRecord,
} from "./helpers/kernel-update-fixture.ts";
import { candidate } from "./helpers/os-agent-runtime-harness.ts";

useSessionOwnerForFile();

const identity = {
	package: kernelRecord.package,
	version: kernelRecord.version,
	deb_sha256: kernelRecord.deb_sha256,
};
const signer = async () => ({
	cn: "CeraLive OTA Manifest Signer",
	eku: ["codeSigning"],
	issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
});
const bytes = new TextEncoder().encode(
	JSON.stringify({
		schema: 1,
		board: candidate.board,
		os_version: candidate.version,
		kernel: identity,
	}),
);
afterEach(() => setOsStageEntryDepsForTest(null));
test("signed sidecar binds the exact board and OS release without widening the channel manifest", async () => {
	expect(
		await verifyKernelSidecar(bytes, new Uint8Array([1]), candidate, signer),
	).toEqual(identity);
	await expect(
		verifyKernelSidecar(
			bytes,
			new Uint8Array([1]),
			{ ...candidate, version: "2026.10.99" },
			signer,
		),
	).rejects.toThrow("os_kernel_identity_unknown");
});
test("bad sidecar signature cannot become kernel authority", async () => {
	await expect(
		verifyKernelSidecar(bytes, new Uint8Array([0]), candidate, async () => {
			throw new Error("bad signature");
		}),
	).rejects.toThrow("os_kernel_identity_unknown");
	await expect(
		verifyKernelSidecar(bytes, new Uint8Array([0]), candidate),
	).rejects.toThrow("os_kernel_identity_unknown");
	await expect(
		verifyKernelSidecar(bytes, new Uint8Array([1]), candidate, async () => ({
			...(await signer()),
			issuer: "CN=Other",
		})),
	).rejects.toThrow("os_kernel_identity_unknown");
});
test("OS admission refuses an older kernel and missing identity only when an overlay exists", async () => {
	await expect(
		admitOsKernelIdentity(
			identity,
			{ ...kernelRecord, version: "7.2.0-ceralive3" },
			true,
		),
	).rejects.toThrow("os_kernel_downgrade");
	await expect(admitOsKernelIdentity(null, kernelRecord, true)).rejects.toThrow(
		"os_kernel_identity_unknown",
	);
	await admitOsKernelIdentity(null, kernelRecord, false);
	await admitOsKernelIdentity(identity, kernelRecord, true);
});
test.each([
	["signed", false, "os_kernel_downgrade"],
	["missing", false, null],
	["missing", true, "os_kernel_identity_unknown"],
	["invalid", false, null],
	["invalid", true, "os_kernel_identity_unknown"],
] as const)(
	"actual pinned sidecar reader handles %s with overlay=%s",
	async (kind, overlay, reason) => {
		const urls: string[] = [];
		const work = checkPinnedOsKernelAdmission(candidate, {
			...defaultOsKernelAdmissionDeps,
			capabilities: async () => ({
				schema: 1,
				features: ["apt-all-packages", "rauc-verity-streaming"],
				ota_uid: process.getuid?.() ?? 1000,
				apt_uid: 42,
			}),
			overlay: async (slot) => (overlay && slot === "A" ? kernelOverlay : null),
			slots: async () => [
				{
					name: "rootfs.0",
					bootname: "A",
					state: "booted",
					bootStatus: "good",
					version: "2026.9.0",
					lastSyncedAt: null,
				},
				{
					name: "rootfs.1",
					bootname: "B",
					state: "inactive",
					bootStatus: "good",
					version: "2026.9.0",
					lastSyncedAt: null,
				},
			],
			booted: async () => ({ ...kernelRecord, version: "7.2.0-ceralive3" }),
			fetch: async (url, target) => {
				urls.push(url);
				if (kind === "missing") return false;
				await writeFile(
					target,
					target.endsWith(".sig") ? new Uint8Array([0]) : bytes,
				);
				return true;
			},
			verify: (data, signature, manifest) =>
				kind === "invalid"
					? verifyKernelSidecar(data, signature, manifest)
					: verifyKernelSidecar(data, signature, manifest, signer),
		});
		if (reason) await expect(work).rejects.toThrow(reason);
		else await work;
		const url = `https://images.ceralive.tv/releases/${candidate.board}/${candidate.version}/kernel.json`;
		expect(urls).toEqual(kind === "missing" ? [url] : [url, `${url}.sig`]);
	},
);
test("real OS stage entry refuses kernel downgrade before dispatching RAUC", async () => {
	let jobs = 0;
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
			data: new TextEncoder().encode(JSON.stringify(candidate)),
			signature: new Uint8Array([1]),
			context: {
				board: candidate.board,
				compatible: candidate.compatible,
				channel: "stable",
				serial: 0,
				bootedVersion: "2026.9.0",
				installedVersion: "2026.10.0",
				now: Date.parse("2026-10-01T00:00:00Z"),
			},
			verification: {
				verifyCms: signer,
				compare: async (a, b) =>
					a.localeCompare(b, "en", { numeric: true }) > 0,
				isQuarantined: async () => false,
			},
		}),
		board: async () => ({
			board: candidate.board,
			compatible: candidate.compatible,
		}),
		booted: async () => "2026.9.0",
		compare: async () => true,
		admitKernel: () =>
			admitOsKernelIdentity(
				identity,
				{ ...kernelRecord, version: "7.2.0-ceralive3" },
				true,
			),
		runJob: async () => {
			jobs++;
			throw new Error("RAUC reached");
		},
	});
	const error = await stageOsBundle(candidate, () => {}).then(
		() => null,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(OsStageError);
	if (!(error instanceof OsStageError))
		throw new Error("missing stage refusal");
	expect(error.cause).toHaveProperty("reason", "os_kernel_downgrade");
	expect(jobs).toBe(0);
});
