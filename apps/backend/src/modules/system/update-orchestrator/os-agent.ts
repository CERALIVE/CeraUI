import { chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { readUpdateCapabilityFile } from "../update-capabilities.ts";
import { loadUpdateSettings } from "../update-settings.ts";
import { selectUpdateTransport } from "../update-transport/executor.ts";
import { updatePinController } from "../update-transport/pin.ts";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import {
	defaultOsChannelDeps,
	OS_UPDATE_STATE_DIR,
	type OsChannel,
	type OsChannelManifest,
	osChannelManifestSchema,
	readBootedOsReleaseVersion,
	resolveOsChannel,
	validateSignedOsManifest,
} from "./os-manifest.ts";
import { UpdateQuarantine } from "./quarantine.ts";

const KEYRING = "/etc/rauc/ceralive-keyring.pem";
const RAUC_CONFIG = "/etc/rauc/system.conf";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
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
	})
	.strict();
export type OsStageReceipt = z.infer<typeof receiptSchema>;

export function parseManifestSignerDetails(
	subject: string,
	extension: string,
): { readonly cn: string; readonly eku: readonly string[] } {
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
	return { cn, eku };
}

export class OsAgentError extends Error {
	override readonly name = "OsAgentError";
	constructor(
		readonly reason: string,
		cause?: unknown,
	) {
		super(reason, { cause });
	}
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
	writeFileAtomicSync(join(dir, "os-staged.json"), JSON.stringify(receipt));
	// This MUST follow confirmed RAUC success; mere signature verification never advances replay protection.
	writeFileAtomicSync(
		join(dir, `manifest-serial.${manifest.channel}`),
		`${manifest.serial}\n`,
	);
	return receipt;
}

export async function readStagedReceipt(): Promise<OsStageReceipt | undefined> {
	if (!(await Bun.file(RECEIPT).exists())) return undefined;
	const parsed = receiptSchema.safeParse(await Bun.file(RECEIPT).json());
	if (!parsed.success) throw new OsAgentError("staged_receipt_invalid");
	return parsed.data;
}

export async function readBootId(): Promise<string> {
	const id = (await Bun.file(BOOT_ID).text()).trim();
	if (!z.uuid().safeParse(id).success)
		throw new OsAgentError("boot_id_unknown");
	return id;
}

export async function readBoardIdentity(): Promise<{
	board: string;
	compatible: string;
}> {
	const conf = await Bun.file(RAUC_CONFIG).text();
	const section = conf.split(/^\[system\]\s*$/m)[1]?.split(/^\[.*\]\s*$/m)[0];
	const matches = section?.match(/^compatible\s*=\s*(\S+)\s*$/gm) ?? [];
	if (matches.length !== 1) throw new OsAgentError("rauc_compatible_unknown");
	const compatible = matches[0]?.split("=")[1]?.trim();
	if (!compatible?.startsWith("ceralive-"))
		throw new OsAgentError("rauc_compatible_unknown");
	const board = compatible.slice("ceralive-".length);
	if (!/^[a-z0-9-]+$/.test(board))
		throw new OsAgentError("rauc_compatible_unknown");
	return { board, compatible };
}

async function command(argv: string[], timeoutMs = 10_000): Promise<string> {
	const result = await spawnWithTimeout(argv, { timeoutMs });
	if (result.exitCode !== 0) throw new OsAgentError("command_failed");
	return result.stdout;
}

async function cmsSigner(
	data: Uint8Array,
	signature: Uint8Array,
): Promise<{ cn: string; eku: readonly string[] }> {
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
			KEYRING,
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
		return parseManifestSignerDetails(subject, extension);
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

async function fetchAsOta(
	url: string,
	target: string,
	uid: number,
): Promise<void> {
	const actualUid = (await command(["id", "-u", "ceralive-ota"])).trim();
	if (actualUid !== String(uid)) throw new OsAgentError("ota_uid_mismatch");
	const result = await spawnWithTimeout(
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
			url,
		],
		{ timeoutMs: 65_000 },
	);
	if (result.exitCode !== 0)
		throw new OsAgentError(
			/\b429\b|\b5\d\d\b/.test(result.stderr)
				? "rate_limited"
				: "manifest_fetch_failed",
		);
}

export async function checkOsChannel(
	settingsChannel: "stable" | "beta",
	quarantine: UpdateQuarantine,
): Promise<OsChannelManifest> {
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
			await fetchAsOta(base, json, file.ota_uid);
			await fetchAsOta(`${base}.sig`, sig, file.ota_uid);
			const installed = (
				await command([
					"dpkg-query",
					"-W",
					"-f=$" + "{Version}",
					"ceralive-device",
				])
			).trim();
			const result = await validateSignedOsManifest(
				new Uint8Array(await Bun.file(json).arrayBuffer()),
				new Uint8Array(await Bun.file(sig).arrayBuffer()),
				{
					board,
					compatible,
					channel,
					serial: await readManifestSerial(channel),
					bootedVersion,
					installedVersion: installed,
					now: Date.now(),
				},
				{
					verifyCms: cmsSigner,
					compare: compareVersions,
					isQuarantined: (version) =>
						quarantine.isOsVersionQuarantined(version),
				},
			);
			if (!result.ok) throw new OsAgentError(result.reason);
			return result.manifest;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

export async function stageOsBundle(
	manifest: OsChannelManifest,
	onProgress: (percent: number) => void,
): Promise<OsStageReceipt> {
	const verified = osChannelManifestSchema.parse(manifest);
	if (getIsStreaming()) throw new OsAgentError("stream_active");
	const settings = await loadUpdateSettings();
	const fresh = await checkOsChannel(settings.channel, new UpdateQuarantine());
	if (
		fresh.version !== verified.version ||
		fresh.channel !== verified.channel ||
		fresh.serial !== verified.serial ||
		fresh.bundle.url !== verified.bundle.url ||
		fresh.bundle.sha256 !== verified.bundle.sha256
	)
		throw new OsAgentError("manifest_changed_before_stage");
	const { board, compatible } = await readBoardIdentity();
	if (verified.board !== board || verified.compatible !== compatible)
		throw new OsAgentError("manifest_identity_changed");
	const booted = await readBootedOsReleaseVersion();
	if (!booted) throw new OsAgentError("booted_version_unknown");
	if (!(await compareVersions(verified.version, booted)))
		throw new OsAgentError("downgrade_or_same");
	const selection = await selectUpdateTransport({
		profile: "os",
		board,
		channel: verified.channel,
	});
	return updatePinController.run("os", selection, async () => {
		// Pin is held until RAUC CLI confirms the whole daemon-owned streaming install finished.
		if (
			getIsStreaming() ||
			(await Bun.file("/run/ceralive/streaming").exists())
		)
			throw new OsAgentError("stream_active");
		let polling = false;
		const timer = setInterval(() => {
			if (polling) return;
			polling = true;
			void Promise.all([
				spawnWithTimeout(
					[
						"busctl",
						"get-property",
						"de.pengutronix.rauc",
						"/",
						"de.pengutronix.rauc.Installer",
						"Operation",
					],
					{ timeoutMs: 5_000 },
				),
				spawnWithTimeout(
					[
						"busctl",
						"get-property",
						"de.pengutronix.rauc",
						"/",
						"de.pengutronix.rauc.Installer",
						"Progress",
					],
					{ timeoutMs: 5_000 },
				),
			])
				.then(([operation, progress]) => {
					if (operation.exitCode !== 0 || progress.exitCode !== 0) return;
					if (/^s "idle"/.test(operation.stdout.trim())) return;
					const match = progress.stdout.match(/^\(isi\)\s+([0-9]{1,3})\b/);
					if (match) onProgress(Math.min(100, Number(match[1])));
				})
				.catch((error) =>
					logger.warn("update-orchestrator: RAUC progress unavailable", {
						error,
					}),
				)
				.finally(() => {
					polling = false;
				});
		}, 3_000);
		timer.unref?.();
		try {
			const result = await spawnWithTimeout(
				[
					"flock",
					"-n",
					"-x",
					SOFTWARE_UPDATE_LOCK,
					"rauc",
					"install",
					verified.bundle.url,
				],
				{ timeoutMs: 2 * 60 * 60_000 },
			);
			if (result.exitCode !== 0) throw new OsAgentError("rauc_install_failed");
		} finally {
			clearInterval(timer);
		}
		return saveStagedManifest(verified, await readBootId(), Date.now());
	});
}

export async function armOsActivation(now = false): Promise<void> {
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
