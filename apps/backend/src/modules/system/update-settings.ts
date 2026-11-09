import { dirname, join } from "node:path";
import {
	type UpdateSettings,
	updateSettingsInputSchema,
	updateSettingsSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";
import { parseAuthorityJson } from "./update-orchestrator/strict-authority-json.ts";

export const UPDATE_SETTINGS_FILE = "update-settings.json";
export const UPDATE_IMAGE_CHANNEL_FILE = "update-image-channel.json";

const imageChannelSchema = z
	.object({
		schema: z.literal(1),
		channel: z.enum(["stable", "beta"]),
		allowSystemDownloadsOverCellular: z.boolean().default(false),
	})
	.strict();

export class UpdateSettingsValidationError extends Error {
	override readonly name = "UpdateSettingsValidationError";
	readonly code = "invalid_update_settings";
}

let updateSettingsFilePath = UPDATE_SETTINGS_FILE;
let imageChannelFilePath: string | null = null;
let systemCellularRevocations = 0;

// A successful revocation also invalidates a read already in flight.
export function createSystemCellularConsentRead(
	loadSettings: () => Promise<UpdateSettings>,
): () => Promise<() => boolean> {
	const revision = systemCellularRevocations;
	return async () => {
		const settings = await loadSettings();
		return () =>
			revision === systemCellularRevocations &&
			settings.allowSystemOverCellular;
	};
}

export function setUpdateSettingsFilePathForTest(
	filePath: string | null,
): void {
	updateSettingsFilePath = filePath ?? UPDATE_SETTINGS_FILE;
}

export function setUpdateImageChannelFilePathForTest(
	filePath: string | null,
): void {
	imageChannelFilePath = filePath;
}

function imageChannelPath(settingsPath: string): string {
	return (
		imageChannelFilePath ??
		join(dirname(settingsPath), UPDATE_IMAGE_CHANNEL_FILE)
	);
}

// No settings file is the factory state, and settings are re-read on every
// orchestrator tick; the shared loader's missing-file warn would repeat every
// 3 s for the life of the process. Say it once per path, at info.
const reportedAbsent = new Set<string>();
const reportedMigrationFailure = new Set<string>();

async function readPreferences<T>(
	filePath: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	let raw: string | null;
	try {
		raw = await readStoredStateFile(filePath, STORED_STATE_LIMITS.settings);
	} catch (cause) {
		logger.warn(`Failed to read config file: ${filePath}`);
		throw new UpdateSettingsValidationError(
			"Unreadable persisted update settings",
			{ cause },
		);
	}
	if (raw === null) return null;
	let value: unknown;
	try {
		value = parseAuthorityJson(raw);
	} catch (cause) {
		logger.warn(`Invalid JSON in config file: ${filePath}`);
		throw new UpdateSettingsValidationError(
			"Invalid persisted update settings",
			{ cause },
		);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new UpdateSettingsValidationError(
			"Invalid persisted update settings",
		);
	}
	return parsed.data;
}

export async function loadUpdateSettings(
	filePath = updateSettingsFilePath,
): Promise<UpdateSettings> {
	const settings = await readPreferences(filePath, updateSettingsSchema);
	const imageChannel = await readPreferences(
		imageChannelPath(filePath),
		imageChannelSchema,
	);
	if (settings === null) {
		if (!reportedAbsent.has(filePath)) {
			reportedAbsent.add(filePath);
			logger.info(`Update settings not saved yet: ${filePath}, using defaults`);
		}
		const defaults = updateSettingsSchema.parse({});
		return imageChannel
			? {
					...defaults,
					channel: imageChannel.channel,
					allowSystemOverCellular:
						imageChannel.allowSystemDownloadsOverCellular,
				}
			: defaults;
	}
	// Older CeraUI rewrites the six-key file with check-only permission.
	// Only the sidecar can retain consent to the newer download contract.
	if (imageChannel)
		return {
			...settings,
			channel: imageChannel.channel,
			allowSystemOverCellular: imageChannel.allowSystemDownloadsOverCellular,
		};

	// Write the rollback-compatible settings first; the sidecar marks migration complete.
	const migrated = {
		...settings,
		channel: "beta" as const,
		allowSystemOverCellular: false,
	};
	try {
		saveUpdateSettings(migrated, filePath);
		logger.info(
			"Update settings moved to the image-only channel: system images follow beta, packages always come from stable",
		);
	} catch (cause) {
		if (!reportedMigrationFailure.has(filePath)) {
			reportedMigrationFailure.add(filePath);
			logger.warn(`Failed to migrate update settings: ${filePath}`, {
				cause: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	return migrated;
}

export function saveUpdateSettings(
	input: unknown,
	filePath = updateSettingsFilePath,
): UpdateSettings {
	const parsed = updateSettingsInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new UpdateSettingsValidationError("Invalid update settings input");
	}
	writeFileAtomicSync(
		filePath,
		JSON.stringify({ ...parsed.data, channel: "stable" }),
	);
	writeFileAtomicSync(
		imageChannelPath(filePath),
		JSON.stringify({
			schema: 1,
			channel: parsed.data.channel,
			allowSystemDownloadsOverCellular: parsed.data.allowSystemOverCellular,
		}),
	);
	if (!parsed.data.allowSystemOverCellular) systemCellularRevocations++;
	return parsed.data;
}
