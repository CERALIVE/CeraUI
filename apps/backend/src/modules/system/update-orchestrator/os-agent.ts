import { randomUUID } from "node:crypto";
import { chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { readUpdateCapabilityFile } from "../update-capabilities.ts";
import { loadUpdateSettings } from "../update-settings.ts";
import { selectUpdateTransport } from "../update-transport/executor.ts";
import { updatePinController } from "../update-transport/pin.ts";
import { clearUpdateNotice } from "./notifications.ts";
import { OsAgentError, readBoardIdentity, readBootId } from "./os-identity.ts";
import {
	installedImageSchema,
	readInstalledImage,
} from "./os-installed-image.ts";
import {
	defaultOsChannelDeps,
	discoverSignedOsManifest,
	type ManifestContext,
	type ManifestVerificationDeps,
	OS_UPDATE_STATE_DIR,
	type OsChannel,
	type OsChannelManifest,
	osChannelManifestSchema,
	readBootedOsReleaseVersion,
	resolveOsChannel,
	validateSignedOsManifest,
} from "./os-manifest.ts";
import {
	type ReceiptFileIdentity,
	readReceiptFile,
} from "./os-receipt-file-identity.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { OsStageUnpublishedSuccessError } from "./os-stage-outcome-error.ts";
import {
	assertOsStageToken,
	defaultOsStageRunEffects,
	type OsStageRunControl,
	type OsStageRunDeps,
	runOsStageJob,
} from "./os-stage-run.ts";
import { UpdateQuarantine } from "./quarantine.ts";

// allow: SIZE_OK — This discovery-only repair must leave the remaining OS lifecycle in place.

const KEYRING = "/etc/rauc/ceralive-keyring.pem";

export { OsAgentError, readBoardIdentity, readBootId };

const RECEIPT = join(OS_UPDATE_STATE_DIR, "os-staged.json");
const CALVER = /^[0-9]{4}\.[0-9]+\.[0-9]+$/;
const SERIAL = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z
	.object({
		schema: z.literal(1),
		version: z.string().regex(CALVER),
		channel: z.enum(["stable", "beta", "drill"]),
		stagedAt: z.number().int().nonnegative(),
		bootId: z.uuid(),
		installedImage: installedImageSchema.optional(),
	})
	.strict();
export type OsStageReceipt = z.infer<typeof receiptSchema>;
export type JudgedOsReceipt = {
	readonly receipt: OsStageReceipt;
	readonly identity: ReceiptFileIdentity;
};
export type OsStageBundleControl = OsStageRunControl & {
	readonly commit?: (receipt: OsStageReceipt) => void;
};

export function parseManifestSignerDetails(
	subject: string,
	extension: string,
	issuer: string,
): {
	readonly cn: string;
	readonly eku: readonly string[];
	readonly issuer: string;
} {
	const cn =
		subject
			.replace(/^subject=/, "")
			.trim()
			.split(",")
			.find((component) => component.startsWith("CN="))
			?.slice(3) ?? "";
	const eku = extension.includes("X509v3 Extended Key Usage:")
		? [
				...(/\b(?:Code Signing|codeSigning|1\.3\.6\.1\.5\.5\.7\.3\.3)\b/.test(
					extension,
				)
					? ["codeSigning"]
					: []),
				...(/\b(?:E-mail Protection|emailProtection|1\.3\.6\.1\.5\.5\.7\.3\.4)\b/.test(
					extension,
				)
					? ["emailProtection"]
					: []),
			]
		: [];
	return {
		cn,
		eku,
		issuer: issuer.replace(/^issuer=/, "").replace(/\r?\n$/, ""),
	};
}

export async function readManifestSerial(
	channel: OsChannel,
	dir = OS_UPDATE_STATE_DIR,
): Promise<number> {
	const path = join(dir, `manifest-serial.${channel}`);
	if (!(await Bun.file(path).exists())) return 0;
	const value = await Bun.file(path).text();
	if (!/^(?:0|[1-9][0-9]*)\n$/.test(value))
		throw new OsAgentError("serial_invalid");
	const parsed = SERIAL.safeParse(Number(value.trim()));
	if (!parsed.success) throw new OsAgentError("serial_invalid");
	return parsed.data;
}

export async function saveStagedManifest(
	manifest: OsChannelManifest,
	bootId: string,
	now: number,
	dir = OS_UPDATE_STATE_DIR,
): Promise<OsStageReceipt> {
	const receipt = receiptSchema.parse({
		schema: 1,
		version: manifest.version,
		channel: manifest.channel,
		bootId,
		stagedAt: now,
	});
	await mkdir(dir, { recursive: true, mode: 0o750 });
	return commitStagedManifest(manifest, receipt, dir);
}

export function commitStagedManifest(
	manifest: OsChannelManifest,
	receipt: OsStageReceipt,
	dir = OS_UPDATE_STATE_DIR,
): OsStageReceipt {
	writeFileAtomicSync(join(dir, "os-staged.json"), JSON.stringify(receipt));
	// This MUST follow confirmed RAUC success; mere signature verification never advances replay protection.
	writeFileAtomicSync(
		join(dir, `manifest-serial.${manifest.channel}`),
		`${manifest.serial}\n`,
	);
	return receipt;
}

/**
 * Moves the receipt to the current boot after a reboot that activated nothing,
 * so the next reboot is judged afresh and the seven-day `@now` clock (keyed on
 * the unchanged `stagedAt`) keeps running on this boot.
 */
export async function rebindStagedReceipt(
	receipt: OsStageReceipt,
	bootId: string,
	dir = OS_UPDATE_STATE_DIR,
): Promise<void> {
	const rebound = receiptSchema.parse({ ...receipt, bootId });
	writeFileAtomicSync(join(dir, "os-staged.json"), JSON.stringify(rebound));
}

export async function readStagedReceipt(): Promise<OsStageReceipt | undefined> {
	if (!(await Bun.file(RECEIPT).exists())) return undefined;
	const parsed = receiptSchema.safeParse(await Bun.file(RECEIPT).json());
	if (!parsed.success) throw new OsAgentError("staged_receipt_invalid");
	return parsed.data;
}

export async function readStagedReceiptEvidence(
	dir = OS_UPDATE_STATE_DIR,
): Promise<JudgedOsReceipt | undefined> {
	const file = readReceiptFile(dir);
	if (!file) return undefined;
	const parsed = receiptSchema.safeParse(
		JSON.parse(file.bytes.toString("utf8")),
	);
	if (!parsed.success) throw new OsAgentError("staged_receipt_invalid");
	return { receipt: parsed.data, identity: file.identity };
}

async function command(argv: string[], timeoutMs = 10_000): Promise<string> {
	const result = await spawnWithTimeout(argv, { timeoutMs });
	if (result.exitCode !== 0) throw new OsAgentError("command_failed");
	return result.stdout;
}

export async function cmsSigner(
	data: Uint8Array,
	signature: Uint8Array,
	keyring = KEYRING,
): Promise<{
	readonly cn: string;
	readonly eku: readonly string[];
	readonly issuer: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "ceraui-cms-"));
	try {
		const json = join(dir, "manifest.json");
		const sig = join(dir, "manifest.sig");
		const cert = join(dir, "signer.pem");
		await Bun.write(json, data);
		await Bun.write(sig, signature);
		await command([
			"openssl",
			"cms",
			"-verify",
			"-binary",
			"-inform",
			"DER",
			"-in",
			sig,
			"-content",
			json,
			"-CAfile",
			keyring,
			"-purpose",
			"any",
			"-signer",
			cert,
			"-out",
			"/dev/null",
		]);
		const signerPem = await Bun.file(cert).text();
		if (signerPem.match(/-----BEGIN CERTIFICATE-----/g)?.length !== 1)
			throw new OsAgentError("signer_ambiguous");
		const subject = await command([
			"openssl",
			"x509",
			"-in",
			cert,
			"-noout",
			"-subject",
			"-nameopt",
			"RFC2253",
		]);
		const extension = await command([
			"openssl",
			"x509",
			"-in",
			cert,
			"-noout",
			"-ext",
			"extendedKeyUsage",
		]);
		const issuer = await command([
			"openssl",
			"x509",
			"-in",
			cert,
			"-noout",
			"-issuer",
			"-nameopt",
			"RFC2253",
		]);
		return parseManifestSignerDetails(subject, extension, issuer);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function compareVersions(left: string, right: string): Promise<boolean> {
	const result = await spawnWithTimeout(
		["dpkg", "--compare-versions", left, "gt", right],
		{ timeoutMs: 10_000 },
	);
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw new OsAgentError("version_comparison_failed");
	return result.exitCode === 0;
}

type OsFetchDeps = {
	readonly readUid: () => Promise<string>;
	readonly run: typeof spawnWithTimeout;
};

export async function fetchAsOta(
	url: string,
	target: string,
	uid: number,
	deps: OsFetchDeps = {
		readUid: async () => (await command(["id", "-u", "ceralive-ota"])).trim(),
		run: spawnWithTimeout,
	},
): Promise<boolean> {
	const actualUid = await deps.readUid();
	if (actualUid !== String(uid)) throw new OsAgentError("ota_uid_mismatch");
	const result = await deps.run(
		[
			"runuser",
			"-u",
			"ceralive-ota",
			"--",
			"curl",
			"-q",
			"--fail",
			"--silent",
			"--show-error",
			"--noproxy",
			"*",
			"--proto",
			"=https",
			"--connect-timeout",
			"10",
			"--max-time",
			"60",
			"--max-filesize",
			"262144",
			"--output",
			target,
			"--write-out",
			"%{http_code}",
			url,
		],
		{ timeoutMs: 65_000 },
	);
	if (
		result.exitCode === 22 &&
		(result.stdout === "404" || result.stdout === "410")
	)
		return false;
	if (result.exitCode !== 0)
		throw new OsAgentError(
			/\b429\b|\b5\d\d\b/.test(result.stderr)
				? "rate_limited"
				: "manifest_fetch_failed",
		);
	return true;
}

type SignedOsChannel = {
	readonly data: Uint8Array;
	readonly signature: Uint8Array;
	readonly context: ManifestContext;
	readonly verification: ManifestVerificationDeps;
};

export async function checkOsChannel(
	settingsChannel: "stable" | "beta",
	quarantine: UpdateQuarantine,
	read: typeof readSignedOsChannel = readSignedOsChannel,
): Promise<OsChannelManifest | undefined> {
	const signed = await read(settingsChannel, quarantine);
	if (!signed) return undefined;
	const result = await discoverSignedOsManifest(
		signed.data,
		signed.signature,
		signed.context,
		signed.verification,
	);
	switch (result.kind) {
		case "candidate":
			return result.manifest;
		case "none":
			if (result.classification === "current") {
				clearUpdateNotice("refused", "os-check:downgrade_or_same");
				clearUpdateNotice("refused", "os-check:serial_replayed");
			}
			return undefined;
		case "refused":
			throw new OsAgentError(result.reason);
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

async function readSignedOsChannel(
	settingsChannel: "stable" | "beta",
	quarantine: UpdateQuarantine,
): Promise<SignedOsChannel | undefined> {
	const bootedVersion = await readBootedOsReleaseVersion();
	if (!bootedVersion) throw new OsAgentError("booted_version_unknown");
	const { board, compatible } = await readBoardIdentity();
	const channel = await resolveOsChannel(settingsChannel, {
		...defaultOsChannelDeps,
		warn: (reason) =>
			logger.warn("update-orchestrator: ignored OS channel override", {
				reason,
			}),
	});
	const selection = await selectUpdateTransport({
		profile: "os",
		board,
		channel,
	});
	const base = `https://images.ceralive.tv/channels/${channel}/${board}.json`;
	return updatePinController.run("os", selection, async () => {
		const file = await readUpdateCapabilityFile();
		if (
			!file?.features.includes("apt-all-packages") ||
			!file.features.includes("rauc-verity-streaming")
		)
			throw new OsAgentError("os_agent_disabled");
		const dir = await mkdtemp(join(tmpdir(), "ceraui-manifest-"));
		try {
			await chown(dir, file.ota_uid, 0);
			const json = join(dir, "manifest.json");
			const sig = join(dir, "manifest.sig");
			if (!(await fetchAsOta(base, json, file.ota_uid))) return undefined;
			if (!(await fetchAsOta(`${base}.sig`, sig, file.ota_uid)))
				return undefined;
			const installed = (
				await command([
					"dpkg-query",
					"-W",
					"-f=$" + "{Version}",
					"ceralive-device",
				])
			).trim();
			return {
				data: new Uint8Array(await Bun.file(json).arrayBuffer()),
				signature: new Uint8Array(await Bun.file(sig).arrayBuffer()),
				context: {
					board,
					compatible,
					channel,
					serial: await readManifestSerial(channel),
					bootedVersion,
					installedVersion: installed,
					now: Date.now(),
				},
				verification: {
					verifyCms: cmsSigner,
					compare: compareVersions,
					isQuarantined: (version) =>
						quarantine.isOsVersionQuarantined(version),
				},
			};
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

type OsStageEntryDeps = {
	readonly settings: typeof loadUpdateSettings;
	readonly readSigned: typeof readSignedOsChannel;
	readonly board: typeof readBoardIdentity;
	readonly booted: typeof readBootedOsReleaseVersion;
	readonly compare: typeof compareVersions;
	readonly runJob: (
		manifest: OsChannelManifest,
		control: OsStageRunControl,
		deps: OsStageRunDeps<OsStageReceipt>,
	) => Promise<OsStageReceipt>;
};
const defaultStageEntry: OsStageEntryDeps = {
	settings: loadUpdateSettings,
	readSigned: readSignedOsChannel,
	board: readBoardIdentity,
	booted: readBootedOsReleaseVersion,
	compare: compareVersions,
	runJob: runOsStageJob,
};
let stageEntry = defaultStageEntry;
export function setOsStageEntryDepsForTest(
	overrides: Partial<OsStageEntryDeps> | null,
): void {
	stageEntry = overrides
		? { ...defaultStageEntry, ...overrides }
		: defaultStageEntry;
}

export async function stageOsBundle(
	manifest: OsChannelManifest,
	onProgress: (percent: number) => void,
	control: OsStageBundleControl = {
		attemptId: randomUUID(),
		signal: new AbortController().signal,
	},
): Promise<OsStageReceipt> {
	try {
		const verified = osChannelManifestSchema.parse(manifest);
		assertOsStageToken(control);
		const settings = await stageEntry.settings();
		const signed = await stageEntry.readSigned(
			settings.channel,
			new UpdateQuarantine(),
		);
		if (!signed) throw new OsAgentError("manifest_changed_before_stage");
		const admitted = await validateSignedOsManifest(
			signed.data,
			signed.signature,
			signed.context,
			signed.verification,
		);
		if (!admitted.ok) throw new OsAgentError(admitted.reason);
		const fresh = admitted.manifest;
		if (
			fresh.version !== verified.version ||
			fresh.channel !== verified.channel ||
			fresh.serial !== verified.serial ||
			fresh.bundle.url !== verified.bundle.url ||
			fresh.bundle.sha256 !== verified.bundle.sha256
		)
			throw new OsAgentError("manifest_changed_before_stage");
		const { board, compatible } = await stageEntry.board();
		if (verified.board !== board || verified.compatible !== compatible)
			throw new OsAgentError("manifest_identity_changed");
		const booted = await stageEntry.booted();
		if (!booted) throw new OsAgentError("booted_version_unknown");
		if (!(await stageEntry.compare(verified.version, booted)))
			throw new OsAgentError("downgrade_or_same");
		return await stageEntry.runJob(verified, control, {
			...defaultOsStageRunEffects,
			selection: () =>
				selectUpdateTransport({
					profile: "os",
					board,
					channel: verified.channel,
				}),
			revalidate: () => revalidatePinnedStage(verified),
			progress: onProgress,
			readProgress: async () => {
				try {
					const progress = await spawnWithTimeout(
						[
							"busctl",
							"get-property",
							"de.pengutronix.rauc",
							"/",
							"de.pengutronix.rauc.Installer",
							"Progress",
						],
						{ timeoutMs: 2_000 },
					);
					const value = /^\(isi\)\s+([0-9]{1,3})\b/.exec(progress.stdout)?.[1];
					return progress.exitCode === 0 && value !== undefined
						? Math.min(100, Number(value))
						: null;
				} catch {
					return null;
				}
			},
			prepareReceipt: async () => {
				const bootId = await readBootId();
				const installedImage = await readInstalledImage("inactive");
				await mkdir(OS_UPDATE_STATE_DIR, { recursive: true, mode: 0o750 });
				const receipt = receiptSchema.parse({
					schema: 1,
					version: verified.version,
					channel: verified.channel,
					bootId,
					stagedAt: Date.now(),
					...(installedImage ? { installedImage } : {}),
				});
				return () => {
					const committed = commitStagedManifest(verified, receipt);
					control.commit?.(committed);
					return committed;
				};
			},
		});
	} catch (cause) {
		if (cause instanceof OsStageUnpublishedSuccessError)
			throw new OsStageError("rauc_recovery_unproven", { cause });
		if (cause instanceof OsStageError) throw cause;
		assertOsStageToken(control);
		throw new OsStageError("rauc_install_failed", { cause });
	}
}

async function revalidatePinnedStage(
	manifest: OsChannelManifest,
): Promise<void> {
	const file = await readUpdateCapabilityFile();
	if (!file) throw new OsAgentError("os_agent_disabled");
	const dir = await mkdtemp(join(tmpdir(), "ceraui-stage-manifest-"));
	try {
		await chown(dir, file.ota_uid, 0);
		const json = join(dir, "manifest.json");
		const sig = join(dir, "manifest.sig");
		const base = `https://images.ceralive.tv/channels/${manifest.channel}/${manifest.board}.json`;
		if (
			!(await fetchAsOta(base, json, file.ota_uid)) ||
			!(await fetchAsOta(`${base}.sig`, sig, file.ota_uid))
		)
			throw new OsAgentError("manifest_changed_before_stage");
		const identity = await readBoardIdentity();
		const result = await validateSignedOsManifest(
			new Uint8Array(await Bun.file(json).arrayBuffer()),
			new Uint8Array(await Bun.file(sig).arrayBuffer()),
			{
				...identity,
				channel: manifest.channel,
				serial: await readManifestSerial(manifest.channel),
				bootedVersion: (await readBootedOsReleaseVersion()) ?? "",
				installedVersion: (
					await command([
						"dpkg-query",
						"-W",
						"-f=$" + "{Version}",
						"ceralive-device",
					])
				).trim(),
				now: Date.now(),
			},
			{
				verifyCms: cmsSigner,
				compare: compareVersions,
				isQuarantined: (version) =>
					new UpdateQuarantine().isOsVersionQuarantined(version),
			},
		);
		if (
			!result.ok ||
			JSON.stringify(result.manifest) !== JSON.stringify(manifest)
		)
			throw new OsAgentError(
				result.ok ? "manifest_changed_before_stage" : result.reason,
			);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function armOsActivation(
	now: boolean,
	control: OsStageControlLease,
): Promise<void> {
	if (!control.held()) throw new OsStageError("rauc_recovery_unproven");
	const result = await spawnWithTimeout(
		["systemctl", "start", `ceralive-rauc-arm@${now ? "now" : "arm"}.service`],
		{ timeoutMs: 30_000 },
	);
	if (result.exitCode !== 0) throw new OsAgentError("activation_arm_failed");
}

export async function inspectOsOperation(): Promise<"idle" | "running"> {
	const result = await spawnWithTimeout(
		[
			"busctl",
			"get-property",
			"de.pengutronix.rauc",
			"/",
			"de.pengutronix.rauc.Installer",
			"Operation",
		],
		{ timeoutMs: 5_000 },
	);
	if (result.exitCode !== 0 || !/^s "[^"]+"\s*$/.test(result.stdout))
		throw new OsAgentError("rauc_operation_unknown");
	return result.stdout.trim() === 's "idle"' ? "idle" : "running";
}
