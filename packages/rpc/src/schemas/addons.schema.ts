/**
 * Add-on descriptor + runtime-state Zod schemas (single source of truth).
 *
 * `AddonDescriptorSchema` mirrors `image-building-pipeline/v2/manifests/schema/
 * addon.schema.json` (T21). That JSON Schema validates the image-baked, read-only
 * descriptors; this Zod schema validates the same shape inside CeraUI at runtime.
 * Field literals (patterns, enums, the G1 sysext identity constants) are mirrored
 * here so Zod is the single TypeScript source — never duplicate the descriptor
 * shape elsewhere in `apps/`.
 *
 * `AddonStateSchema` / `AddonConfigSchema` describe per-feature *runtime* state
 * persisted under the `addons` key of `config.json` — they have no JSON Schema
 * counterpart because they are device-local, not baked into the image.
 */
import { z } from 'zod';

// Reject arrays whose JSON Schema source declares `uniqueItems: true`.
const isUnique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;
const uniqueArray = <T extends z.ZodTypeAny>(item: T) =>
	z.array(item).refine(isUnique, { message: 'items must be unique' });

// Add-on id and the deps[]/conflicts[] references to other add-on ids:
// lowercase alphanumeric with internal hyphens. NOT a Debian package name —
// distinct, stricter charset than APT_PACKAGE_NAME_RE on purpose.
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// Semver MAJOR.MINOR.PATCH with optional -prerelease / +build.
const SEMVER_RE =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// G2 — a systemd-sysext overlays ONLY /usr and /opt; paths elsewhere are lost at
// merge time, so the descriptor rejects them up front.
const SYSEXT_PATH_RE = /^\/(usr|opt)\/.+$/;
// Bare OS VERSION_ID token substituted into artifact.urlTemplate's {os_version}.
const OS_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
// HTTPS artifact URL that MUST carry the literal {os_version} placeholder.
const ARTIFACT_URL_RE = /^https:\/\/[^\s]*\{os_version\}[^\s]*$/;
// Lowercase hex SHA-256 (64 chars).
const SHA256_RE = /^[a-f0-9]{64}$/;
// systemd unit name with a mandatory unit-type suffix.
const SYSTEMD_UNIT_RE = /^[A-Za-z0-9@._:-]+\.(service|socket|target|timer|path|mount)$/;

export const ADDON_CATEGORIES = ['debug', 'display', 'media', 'network', 'other'] as const;
export const addonCategorySchema = z.enum(ADDON_CATEGORIES);
export type AddonCategory = z.infer<typeof addonCategorySchema>;

const addonIdSchema = z.string().regex(ADDON_ID_RE);

// Only the sysext payload backend is implemented; appfs is reserved (rejected).
export const addonPayloadSchema = z
	.object({
		type: z.literal('sysext'),
	})
	.strict();

export const addonArtifactSchema = z
	.object({
		urlTemplate: z.string().regex(ARTIFACT_URL_RE),
		sha256: z.string().regex(SHA256_RE),
		gpgSigRef: z.string().min(1),
		sizeDownload: z.number().int().min(1),
		sizeInstalled: z.number().int().min(1),
	})
	.strict();

export const addonUnitsSchema = z
	.object({
		unmask: uniqueArray(z.string().regex(SYSTEMD_UNIT_RE)).optional(),
		enable: uniqueArray(z.string().regex(SYSTEMD_UNIT_RE)).optional(),
		start: uniqueArray(z.string().regex(SYSTEMD_UNIT_RE)).optional(),
	})
	.strict();

export const addonValidateSchema = z
	.object({
		cmd: z.string().min(1),
		timeout: z.number().int().min(1).optional(),
	})
	.strict();

export const AddonDescriptorSchema = z
	.object({
		id: addonIdSchema,
		name: z.string().min(1),
		version: z.string().regex(SEMVER_RE),
		category: addonCategorySchema,
		icon: z.string().min(1).optional(),
		payload: addonPayloadSchema,
		// G1 — sysext merge identity the kernel keys on. Both are fixed literals;
		// any other value is un-mergeable on the device.
		sysextLevel: z.literal('1'),
		versionId: z.literal('12'),
		compatibleOsVersions: uniqueArray(z.string().regex(OS_VERSION_RE)).min(1).optional(),
		artifact: addonArtifactSchema,
		provides: uniqueArray(z.string().regex(SYSEXT_PATH_RE)).min(1),
		deps: uniqueArray(addonIdSchema).optional(),
		conflicts: uniqueArray(addonIdSchema).optional(),
		units: addonUnitsSchema.optional(),
		configSchemaRef: z.string().min(1).optional(),
		validate: addonValidateSchema.optional(),
	})
	.strict();
export type AddonDescriptor = z.infer<typeof AddonDescriptorSchema>;

// Lifecycle phase of one add-on as the manager materialises/enables/disables it.
export const ADDON_PHASES = ['idle', 'installing', 'active', 'disabling', 'error'] as const;
export const addonPhaseSchema = z.enum(ADDON_PHASES);
export type AddonPhase = z.infer<typeof addonPhaseSchema>;

// Per-feature runtime state persisted under config.json's `addons` key. No JSON
// Schema counterpart — this is device-local state, not an image-baked descriptor.
export const AddonStateSchema = z
	.object({
		enabled: z.boolean(),
		phase: addonPhaseSchema,
		versionMaterialized: z.string().optional(),
		userConfig: z.record(z.string(), z.unknown()).optional(),
		lastError: z.string().optional(),
		autoDisabled: z.boolean(),
	})
	.strict();
export type AddonState = z.infer<typeof AddonStateSchema>;

// The whole `addons` map in config.json: add-on id -> its runtime state.
export const AddonConfigSchema = z.record(z.string(), AddonStateSchema);
export type AddonConfig = z.infer<typeof AddonConfigSchema>;
