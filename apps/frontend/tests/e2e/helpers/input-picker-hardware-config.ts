const HARDWARE_ENABLE_ENV = 'CERAUI_INPUT_HARDWARE';
const HARDWARE_URL_ENV = 'CERAUI_INPUT_HARDWARE_URL';
const HARDWARE_PASSWORD_ENV = 'CERAUI_INPUT_HARDWARE_PASSWORD';
const PRIMARY_INPUT_ENV = 'CERAUI_INPUT_PRIMARY_ID';
const TARGET_INPUT_ENV = 'CERAUI_INPUT_TARGET_ID';
const INPUT_ID_RE = /^[A-Za-z0-9._:-]+$/;

export const hardwareInputPickerEnabled =
	process.env[HARDWARE_ENABLE_ENV] === '1';

export const HARDWARE_INPUT_PICKER_PREREQUISITE =
	'NOT EXECUTED: the real Rock 5B+ gate requires CERAUI_INPUT_HARDWARE=1, a device URL/password, primary + target input ids, and the physical attach/unplug protocol in INPUT_PICKER_HARDWARE_QA.md. Mock results do not satisfy this gate.';

export class HardwareInputPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HardwareInputPrerequisiteError';
	}
}

export type HardwareInputConfig = {
	readonly deviceUrl: string;
	readonly password: string;
	readonly primaryInputId: string;
	readonly targetInputId: string;
};

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new HardwareInputPrerequisiteError(
			`${name} is required when ${HARDWARE_ENABLE_ENV}=1`,
		);
	}
	return value;
}

function parseInputId(name: string): string {
	const value = requiredEnv(name).trim();
	if (!INPUT_ID_RE.test(value)) {
		throw new HardwareInputPrerequisiteError(
			`${name} must match ${INPUT_ID_RE.source}; received ${JSON.stringify(value)}`,
		);
	}
	return value;
}

export function readHardwareInputConfig(): HardwareInputConfig {
	if (!hardwareInputPickerEnabled) {
		throw new HardwareInputPrerequisiteError(
			HARDWARE_INPUT_PICKER_PREREQUISITE,
		);
	}

	const rawUrl = requiredEnv(HARDWARE_URL_ENV).trim();
	let deviceUrl: URL;
	try {
		deviceUrl = new URL(rawUrl);
	} catch (error) {
		if (error instanceof TypeError) {
			throw new HardwareInputPrerequisiteError(
				`${HARDWARE_URL_ENV} must be an absolute HTTP(S) URL`,
			);
		}
		throw error;
	}
	if (deviceUrl.protocol !== 'http:' && deviceUrl.protocol !== 'https:') {
		throw new HardwareInputPrerequisiteError(
			`${HARDWARE_URL_ENV} must use http: or https:`,
		);
	}

	const primaryInputId = parseInputId(PRIMARY_INPUT_ENV);
	const targetInputId = parseInputId(TARGET_INPUT_ENV);
	if (primaryInputId === targetInputId) {
		throw new HardwareInputPrerequisiteError(
			`${PRIMARY_INPUT_ENV} and ${TARGET_INPUT_ENV} must name different physical inputs`,
		);
	}

	const password = requiredEnv(HARDWARE_PASSWORD_ENV);
	if (password.length < 8) {
		throw new HardwareInputPrerequisiteError(
			`${HARDWARE_PASSWORD_ENV} must satisfy the device's 8-character minimum`,
		);
	}

	return {
		deviceUrl: deviceUrl.href,
		password,
		primaryInputId,
		targetInputId,
	};
}
