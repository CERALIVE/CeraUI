import { chown, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readUpdateCapabilityFile } from "../update-capabilities.ts";
import { selectUpdateTransport } from "../update-transport/executor.ts";
import { updatePinController } from "../update-transport/pin.ts";
import { kernelVersionGreater, readBootedKernel } from "./kernel-packages.ts";
import {
	type KernelIdentity,
	KernelUpdateError,
	kernelIdentitySchema,
	readSlotOverlay,
} from "./kernel-state.ts";
import { cmsSigner, fetchAsOta } from "./os-agent.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import { readRootSlots } from "./slot-status.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "./strict-authority-json.ts";

export const osKernelSidecarSchema = z
	.object({
		schema: z.literal(1),
		board: z.string(),
		os_version: z.string(),
		kernel: kernelIdentitySchema,
	})
	.strict();

export async function verifyKernelSidecar(
	data: Uint8Array,
	signature: Uint8Array,
	manifest: OsChannelManifest,
	verify = cmsSigner,
): Promise<KernelIdentity> {
	const signer = await verify(data, signature).catch((cause: unknown) => {
		throw new KernelUpdateError("os_kernel_identity_unknown", { cause });
	});
	if (
		signer.cn !== "CeraLive OTA Manifest Signer" ||
		!signer.eku.includes("codeSigning") ||
		signer.eku.includes("emailProtection") ||
		![
			"CN=CeraLive RAUC Intermediate CA,O=CeraLive",
			"CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive",
		].includes(signer.issuer)
	)
		throw new KernelUpdateError("os_kernel_identity_unknown");
	const parsed = osKernelSidecarSchema.parse(
		parseAuthorityJson(decodeAuthorityUtf8(data)),
	);
	if (parsed.board !== manifest.board || parsed.os_version !== manifest.version)
		throw new KernelUpdateError("os_kernel_identity_unknown");
	return parsed.kernel;
}

export async function admitOsKernelIdentity(
	candidate: KernelIdentity | null,
	booted: Pick<KernelIdentity, "package" | "version">,
	hasOverlay: boolean,
	greater = kernelVersionGreater,
): Promise<void> {
	if (!candidate) {
		if (hasOverlay) throw new KernelUpdateError("os_kernel_identity_unknown");
		return;
	}
	if (await greater(booted.version, candidate.version))
		throw new KernelUpdateError("os_kernel_downgrade");
}

/** Called inside the existing OS transport pin for each final manifest recheck. */
export const defaultOsKernelAdmissionDeps = {
	capabilities: readUpdateCapabilityFile,
	overlay: readSlotOverlay,
	slots: readRootSlots,
	booted: readBootedKernel,
	fetch: fetchAsOta,
	verify: verifyKernelSidecar,
};
export async function checkPinnedOsKernelAdmission(
	manifest: OsChannelManifest,
	deps = defaultOsKernelAdmissionDeps,
): Promise<void> {
	const file = await deps.capabilities();
	const overlays = await Promise.all([deps.overlay("A"), deps.overlay("B")]);
	if (!file) {
		if (overlays.some((overlay) => overlay !== null))
			throw new KernelUpdateError("os_kernel_identity_unknown");
		return;
	}
	let overlay = null;
	if (overlays.some((value) => value !== null)) {
		const slots = await deps.slots();
		const bootname = slots.find((slot) => slot.state === "booted")?.bootname;
		if (bootname !== "A" && bootname !== "B")
			throw new KernelUpdateError("os_kernel_identity_unknown");
		overlay = await deps.overlay(bootname);
	}
	const directory = await mkdtemp(join(tmpdir(), "ceraui-kernel-sidecar-"));
	let identity: KernelIdentity | null = null;
	try {
		await chown(directory, file.ota_uid, -1);
		const json = join(directory, "kernel.json");
		const sig = join(directory, "kernel.json.sig");
		const url = `https://images.ceralive.tv/releases/${manifest.board}/${manifest.version}/kernel.json`;
		if (
			(await deps.fetch(url, json, file.ota_uid)) &&
			(await deps.fetch(`${url}.sig`, sig, file.ota_uid))
		) {
			identity = await deps.verify(
				new Uint8Array(await Bun.file(json).arrayBuffer()),
				new Uint8Array(await Bun.file(sig).arrayBuffer()),
				manifest,
			);
		}
	} catch (error) {
		// Missing/invalid sidecars preserve legacy behavior only without a local overlay.
		if (overlay)
			throw new KernelUpdateError("os_kernel_identity_unknown", {
				cause: error,
			});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	if (!identity && !overlay) return;
	await admitOsKernelIdentity(identity, await deps.booted(), overlay !== null);
}

export async function checkOsKernelAdmission(
	manifest: OsChannelManifest,
): Promise<void> {
	const file = await readUpdateCapabilityFile();
	if (!file) {
		const overlays = await Promise.all([
			readSlotOverlay("A"),
			readSlotOverlay("B"),
		]);
		if (overlays.every((overlay) => overlay === null)) return;
		throw new KernelUpdateError("os_kernel_identity_unknown");
	}
	const selection = await selectUpdateTransport({
		profile: "os",
		board: manifest.board,
		channel: manifest.channel,
	});
	await updatePinController.run("os", selection, () =>
		checkPinnedOsKernelAdmission(manifest),
	);
}
