import {
	type UpdateSettings,
	updateSettingsInputSchema,
	updateSettingsSchema,
} from "@ceraui/rpc/schemas";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";
import { parseAuthorityJson } from "./update-orchestrator/strict-authority-json.ts";

export const UPDATE_SETTINGS_FILE = "update-settings.json";

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

export async function loadUpdateSettings(
	filePath = updateSettingsFilePath,
): Promise<UpdateSettings> {
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
	if (raw === null) {
		if (!reportedAbsent.has(filePath)) {
			reportedAbsent.add(filePath);
			logger.info(`Update settings not saved yet: ${filePath}, using defaults`);
		}
		return updateSettingsSchema.parse({});
	}
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
	const parsed = updateSettingsSchema.safeParse(value);
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
