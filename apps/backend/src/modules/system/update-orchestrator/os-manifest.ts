import { lstat } from "node:fs/promises";
import { z } from "zod";

export const BOOTED_OS_RELEASE_VERSION = "/etc/ceralive/os-release-version";
export const OS_CHANNEL_OVERRIDE =
	"/data/ceralive/update-state/os-channel-override";
export const OS_UPDATE_STATE_DIR = "/data/ceralive/update-state";
const calVer = z.string().regex(/^[0-9]{4}\.[0-9]+\.[0-9]+$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const artifact = z
	.object({
		url: z.url().startsWith("https://images.ceralive.tv/releases/"),
		size: z.number().int().positive(),
		sha256: digest,
	})
	.strict();

export const osChannelManifestSchema = z
	.object({
		schema: z.literal(1),
		board: z.string().regex(/^[a-z0-9-]+$/),
		compatible: z.string().min(1),
		channel: z.enum(["stable", "beta", "drill"]),
		version: calVer,
		serial: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		published_at: z.iso.datetime(),
		expires_at: z.iso.datetime(),
		os_version_id: z.string().min(1),
		min_ceraui_version: calVer,
		bundle: artifact,
		flash: artifact.extend({ raw_sha256: digest }),
		lock_url: z.url().startsWith("https://images.ceralive.tv/releases/"),
	})
	.strict();
export type OsChannelManifest = z.infer<typeof osChannelManifestSchema>;
export type OsChannel = OsChannelManifest["channel"];

export type ManifestRefusal =
	| "signature_invalid"
	| "signer_not_manifest_signer"
	| "schema_invalid"
	| "wrong_board"
	| "wrong_compatible"
	| "wrong_channel"
	| "serial_replayed"
	| "expired"
	| "booted_version_unknown"
	| "downgrade_or_same"
	| "version_quarantined"
	| "ceraui_too_old";
export type ManifestResult =
	| { readonly ok: true; readonly manifest: OsChannelManifest }
	| { readonly ok: false; readonly reason: ManifestRefusal };

export type ManifestContext = {
	readonly board: string;
	readonly compatible: string;
	readonly channel: OsChannel;
	readonly serial: number;
	readonly bootedVersion: string | undefined;
	readonly installedVersion: string;
	readonly now: number;
};
export type ManifestVerificationDeps = {
	readonly verifyCms: (
		data: Uint8Array,
		signature: Uint8Array,
	) => Promise<{ readonly cn: string; readonly eku: readonly string[] }>;
	readonly compare: (candidate: string, installed: string) => Promise<boolean>;
	readonly isQuarantined: (version: string) => Promise<boolean>;
};

/** CMS trust precedes *all* manifest parsing: an unsigned payload reveals no field-validation result. */
export async function validateSignedOsManifest(
	data: Uint8Array,
	signature: Uint8Array,
	context: ManifestContext,
	deps: ManifestVerificationDeps,
): Promise<ManifestResult> {
	let signer: Awaited<ReturnType<ManifestVerificationDeps["verifyCms"]>>;
	try {
		signer = await deps.verifyCms(data, signature);
	} catch {
		return { ok: false, reason: "signature_invalid" };
	}
	if (
		signer.cn !== "CeraLive OTA Manifest Signer" ||
		!signer.eku.includes("codeSigning") ||
		signer.eku.includes("emailProtection")
	)
		return { ok: false, reason: "signer_not_manifest_signer" };
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
	} catch {
		return { ok: false, reason: "schema_invalid" };
	}
	const parsed = osChannelManifestSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, reason: "schema_invalid" };
	const manifest = parsed.data;
	if (manifest.board !== context.board)
		return { ok: false, reason: "wrong_board" };
	if (manifest.compatible !== context.compatible)
		return { ok: false, reason: "wrong_compatible" };
	if (manifest.channel !== context.channel)
		return { ok: false, reason: "wrong_channel" };
	if (manifest.serial <= context.serial)
		return { ok: false, reason: "serial_replayed" };
	if (Date.parse(manifest.expires_at) <= context.now)
		return { ok: false, reason: "expired" };
	if (
		!context.bootedVersion ||
		!calVer.safeParse(context.bootedVersion).success
	)
		return { ok: false, reason: "booted_version_unknown" };
	if (!(await deps.compare(manifest.version, context.bootedVersion)))
		return { ok: false, reason: "downgrade_or_same" };
	if (await deps.isQuarantined(manifest.version))
		return { ok: false, reason: "version_quarantined" };
	if (await deps.compare(manifest.min_ceraui_version, context.installedVersion))
		return { ok: false, reason: "ceraui_too_old" };
	return { ok: true, manifest };
}

export async function readBootedOsReleaseVersion(
	path = BOOTED_OS_RELEASE_VERSION,
): Promise<string | undefined> {
	try {
		const value = await Bun.file(path).text();
		if (!/^[0-9]{4}\.[0-9]+\.[0-9]+\n$/.test(value)) return undefined;
		return value.slice(0, -1);
	} catch {
		return undefined;
	}
}

type Override = {
	readonly content: string;
	readonly uid: number;
	readonly mode: number;
	readonly regular: boolean;
};
type ChannelDeps = {
	readonly readOverride: () => Promise<Override | undefined>;
	readonly warn: (reason: string) => void;
};
export const defaultOsChannelDeps: ChannelDeps = {
	readOverride: async () => {
		try {
			const info = await lstat(OS_CHANNEL_OVERRIDE);
			if (!info.isFile())
				return {
					content: "",
					uid: info.uid,
					mode: info.mode & 0o777,
					regular: false,
				};
			return {
				content: await Bun.file(OS_CHANNEL_OVERRIDE).text(),
				uid: info.uid,
				mode: info.mode & 0o777,
				regular: true,
			};
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		}
	},
	warn: () => {
		/* The caller supplies the device logger when warnings are actionable. */
	},
};

export async function resolveOsChannel(
	settingsChannel: "stable" | "beta",
	deps: ChannelDeps = defaultOsChannelDeps,
): Promise<OsChannel> {
	let override: Override | undefined;
	try {
		override = await deps.readOverride();
	} catch {
		deps.warn("os-channel-override-unreadable");
		return settingsChannel;
	}
	if (!override) return settingsChannel;
	if (
		override.regular &&
		override.uid === 0 &&
		(override.mode & ~0o644) === 0 &&
		override.content === "drill"
	)
		return "drill";
	deps.warn("os-channel-override-invalid");
	return settingsChannel;
}
