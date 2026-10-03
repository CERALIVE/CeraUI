import { stat } from "node:fs/promises";
import {
	type UpdateSettings,
	updateSettingsInputSchema,
	updateSettingsSchema,
} from "@ceraui/rpc/schemas";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

export const UPDATE_SETTINGS_FILE = "update-settings.json";
const DEFAULTS = updateSettingsSchema.parse({});

export class UpdateSettingsValidationError extends Error {
	override readonly name = "UpdateSettingsValidationError";
	readonly code = "invalid_update_settings";
}

let updateSettingsFilePath = UPDATE_SETTINGS_FILE;

export function setUpdateSettingsFilePathForTest(
	filePath: string | null,
): void {
	updateSettingsFilePath = filePath ?? UPDATE_SETTINGS_FILE;
}

// No settings file is the factory state, and settings are re-read on every
// orchestrator tick; the shared loader's missing-file warn would repeat every
// 3 s for the life of the process. Say it once per path, at info.
const reportedAbsent = new Set<string>();

// Bun.file().exists() is also false for a directory, so only ENOENT counts as
// the factory state; any other path state keeps the shared loader's warning.
async function isAbsent(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	}
}

export async function loadUpdateSettings(
	filePath = updateSettingsFilePath,
): Promise<UpdateSettings> {
	const present = await Bun.file(filePath).exists();
	if (!present && (await isAbsent(filePath))) {
		if (!reportedAbsent.has(filePath)) {
			reportedAbsent.add(filePath);
			logger.info(`Update settings not saved yet: ${filePath}, using defaults`);
		}
		return updateSettingsSchema.parse({});
	}
	const result = await loadJsonConfig(filePath, updateSettingsSchema, DEFAULTS);
	if (
		present &&
		(!result.loaded ||
			result.invalidFields.length > 0 ||
			(result.modified && result.defaultedFields.length === 0))
	) {
		throw new UpdateSettingsValidationError(
			"Invalid persisted update settings",
		);
	}
	const parsed = updateSettingsSchema.safeParse(result.data);
	if (!parsed.success) {
		throw new UpdateSettingsValidationError(
			"Invalid persisted update settings",
		);
	}
	return parsed.data;
}

export function saveUpdateSettings(
	input: unknown,
	filePath = updateSettingsFilePath,
): UpdateSettings {
	const parsed = updateSettingsInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new UpdateSettingsValidationError("Invalid update settings input");
	}
	writeFileAtomicSync(filePath, JSON.stringify(parsed.data));
	return parsed.data;
}
