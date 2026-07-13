import fs from 'node:fs';
import path from 'node:path';

import { evidencePath } from './index.js';
import { readHardwareInputConfig } from './input-picker-hardware-config.js';

const PASS_ARTIFACT = evidencePath('input-picker-rock5b-hardware.json');
const DEFAULT_REPORT_ARTIFACT = path.resolve(
	import.meta.dirname,
	'../../../input-picker-rock5b-report.json',
);

function configuredReportArtifact(): string | undefined {
	const configured = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME?.trim();
	if (configured === undefined || configured.length === 0) return undefined;
	return path.resolve(process.cwd(), configured);
}

export function clearInputPickerHardwareArtifacts(): void {
	const artifacts = new Set([PASS_ARTIFACT, DEFAULT_REPORT_ARTIFACT]);
	const configuredReport = configuredReportArtifact();
	if (configuredReport !== undefined) artifacts.add(configuredReport);
	for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
}

export function prepareDedicatedInputPickerHardwareRun(): void {
	clearInputPickerHardwareArtifacts();
	void readHardwareInputConfig();
}
