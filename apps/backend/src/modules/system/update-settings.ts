import {
	type UpdateSettings,
	updateSettingsInputSchema,
	updateSettingsSchema,
} from "@ceraui/rpc/schemas";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";

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

export async function loadUpdateSettings(
	filePath = updateSettingsFilePath,
): Promise<UpdateSettings> {
	const present = await Bun.file(filePath).exists();
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
