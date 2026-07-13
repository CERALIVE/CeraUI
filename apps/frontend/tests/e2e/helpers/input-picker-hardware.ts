import fs from 'node:fs';
import path from 'node:path';

import { sourcesMessageSchema } from '@ceraui/rpc/schemas';
import { expect, type Page, type TestInfo } from '@playwright/test';

import { evidencePath, navigateTo } from './index.js';
import {
	HardwareInputPrerequisiteError,
	type HardwareInputConfig,
	readHardwareInputConfig,
} from './input-picker-hardware-config.js';

const OPERATOR_ACTION_TIMEOUT_MS = 120_000;
const HARDWARE_TEST_TIMEOUT_MS = 420_000;
const PASS_ARTIFACT_NAME = 'input-picker-rock5b-hardware.json';

type SourceObserver = {
	readonly socketUrls: () => readonly string[];
	readonly hardware: () => string | undefined;
	readonly sawTargetAvailable: () => boolean;
	readonly sawTargetLost: () => boolean;
};

function observeRealSourceFrames(page: Page, targetInputId: string): SourceObserver {
	const socketUrls: string[] = [];
	let hardware: string | undefined;
	let targetAvailable = false;
	let targetLost = false;

	page.on('websocket', (socket) => {
		socketUrls.push(socket.url());
		socket.on('framereceived', ({ payload }) => {
			if (typeof payload !== 'string') return;

			let frame: unknown;
			try {
				frame = JSON.parse(payload);
			} catch (error) {
				if (error instanceof SyntaxError) return;
				throw error;
			}
			if (typeof frame !== 'object' || frame === null || !('sources' in frame)) {
				return;
			}

			const parsed = sourcesMessageSchema.safeParse(frame.sources);
			if (!parsed.success) return;
			hardware = parsed.data.hardware;
			const target = parsed.data.sources.find(
				(source) => source.id === targetInputId,
			);
			if (target?.available === true && target.lost !== true) {
				targetAvailable = true;
			}
			if (target?.available === false && target.lost === true) {
				targetLost = true;
			}
		});
	});

	return {
		socketUrls: () => [...socketUrls],
		hardware: () => hardware,
		sawTargetAvailable: () => targetAvailable,
		sawTargetLost: () => targetLost,
	};
}

function expectedSocketOrigin(deviceUrl: string): string {
	const expected = new URL(deviceUrl);
	expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
	return expected.origin;
}

function matchingSocketUrl(
	socketUrls: readonly string[],
	deviceUrl: string,
): string | undefined {
	const expected = expectedSocketOrigin(deviceUrl);
	return socketUrls.find((socketUrl) => new URL(socketUrl).origin === expected);
}

async function authenticateExistingHardware(
	page: Page,
	password: string,
): Promise<void> {
	const header = page.locator('header').first();
	const passwordField = page.locator('#password');
	await expect(header.or(passwordField)).toBeVisible({ timeout: 60_000 });
	await page.evaluate(() => document.getElementById('js-failed')?.remove());
	if (await header.isVisible()) return;
	if (await page.locator('#confirm-password').isVisible()) {
		throw new HardwareInputPrerequisiteError(
			'The Rock 5B+ is in first-run password setup. Provision it before QA; this gate refuses to mutate device credentials.',
		);
	}

	await passwordField.fill(password);
	await page.locator('form button[type="submit"]').click();
	await expect(header).toBeVisible({ timeout: 15_000 });
}

function inputRow(page: Page, inputId: string) {
	return page.locator(`[data-source-switch-row="${inputId}"]`);
}

function switchButton(page: Page, inputId: string) {
	return page.locator(`[data-switch-input="${inputId}"]`);
}

function writePassArtifact(
	config: HardwareInputConfig,
	result: {
		readonly hardware: string;
		readonly rpcWebSocketOrigin: string;
		readonly switchGapMs: number;
	},
): string {
	const artifactPath = evidencePath(PASS_ARTIFACT_NAME);
	fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
	fs.writeFileSync(
		artifactPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				status: 'passed',
				deviceClass: result.hardware,
				uiOrigin: new URL(config.deviceUrl).origin,
				rpcWebSocketOrigin: result.rpcWebSocketOrigin,
				primaryInputId: config.primaryInputId,
				targetInputId: config.targetInputId,
				observed: {
					realAttach: true,
					switchSuccess: true,
					switchGapMs: result.switchGapMs,
					targetBecameActive: true,
					realDetachLostBroadcast: true,
				},
				generatedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		'utf8',
	);
	return artifactPath;
}

export async function runRock5bInputPickerGate(
	{ page }: { readonly page: Page },
	testInfo: TestInfo,
): Promise<void> {
	testInfo.setTimeout(HARDWARE_TEST_TIMEOUT_MS);
	fs.rmSync(evidencePath(PASS_ARTIFACT_NAME), { force: true });
	const config = readHardwareInputConfig();
	const observer = observeRealSourceFrames(page, config.targetInputId);

	await page.addInitScript(() => {
		localStorage.removeItem('auth');
		localStorage.setItem('locale', JSON.stringify({ code: 'en' }));
	});
	await page.goto(config.deviceUrl, { waitUntil: 'domcontentloaded' });
	expect(new URL(page.url()).origin).toBe(new URL(config.deviceUrl).origin);
	await authenticateExistingHardware(page, config.password);
	await navigateTo(page, 'live');

	await expect
		.poll(
			() => matchingSocketUrl(observer.socketUrls(), config.deviceUrl),
			{
				timeout: 15_000,
				message: 'RPC WebSocket must terminate on the Rock 5B+ UI origin',
			},
		)
		.toBeDefined();
	await expect
		.poll(observer.hardware, {
			timeout: 15_000,
			message: 'real sources broadcast must identify the RK3588 device class',
		})
		.toBe('rk3588');
	await expect(page.getByTestId('live-cockpit')).toBeVisible({ timeout: 15_000 });

	const targetButton = switchButton(page, config.targetInputId);
	await expect(targetButton).toHaveCount(0);

	await expect(targetButton).toBeVisible({ timeout: OPERATOR_ACTION_TIMEOUT_MS });
	await expect
		.poll(observer.sawTargetAvailable, {
			timeout: 15_000,
			message: 'real sources broadcast must report the hotplugged target available',
		})
		.toBe(true);
	await expect(inputRow(page, config.primaryInputId)).toHaveAttribute(
		'data-active',
		'true',
	);

	await targetButton.click();
	const toast = page.getByText(/Switched in \d+ms/i).last();
	await expect(toast).toBeVisible({ timeout: 15_000 });
	const toastText = await toast.textContent();
	const gapText = toastText?.match(/(\d+)ms/i)?.[1];
	if (gapText === undefined) {
		throw new Error(`Switch success toast did not expose gap_ms: ${toastText ?? ''}`);
	}
	const switchGapMs = Number.parseInt(gapText, 10);
	expect(switchGapMs).toBeLessThanOrEqual(67);
	await expect(inputRow(page, config.targetInputId)).toHaveAttribute(
		'data-active',
		'true',
		{ timeout: 15_000 },
	);

	await expect
		.poll(observer.sawTargetLost, {
			timeout: OPERATOR_ACTION_TIMEOUT_MS,
			message: 'real sources broadcast must mark the unplugged target lost',
		})
		.toBe(true);
	await expect(inputRow(page, config.targetInputId)).toBeVisible();
	await expect(switchButton(page, config.targetInputId)).toBeDisabled();

	const rpcWebSocketUrl = matchingSocketUrl(
		observer.socketUrls(),
		config.deviceUrl,
	);
	if (rpcWebSocketUrl === undefined) {
		throw new Error('Matching real-device RPC WebSocket disappeared before evidence write');
	}
	const artifactPath = writePassArtifact(config, {
		hardware: 'rk3588',
		rpcWebSocketOrigin: new URL(rpcWebSocketUrl).origin,
		switchGapMs,
	});
	await testInfo.attach('input-picker-rock5b-hardware', {
		path: artifactPath,
		contentType: 'application/json',
	});
}
