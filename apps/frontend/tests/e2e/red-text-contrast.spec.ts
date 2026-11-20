import type { Locator, Page } from '@playwright/test';

import { expect, type PageRpc, test } from './fixtures/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * Red text reads at WCAG AA 4.5:1 against the surface it is actually painted
 * on, in both themes: the Audio dialog's no-audio-support band (a red heading
 * and line over a light red wash on the dialog), a failed add-on's badge and
 * error line (red status text on its own red tint over the card), and the Lost
 * badge of an unplugged capture source, whose row is disabled and dimmed. The
 * ratio is read from the pixels Chromium paints, so every ancestor's tint,
 * opacity and blend counts.
 */

/** One pixel from the centre of `swatch` as Chromium painted it, 0-255 RGB. */
async function paintedPixel(swatch: Locator): Promise<number[]> {
	const png = await swatch.screenshot();
	return swatch.page().evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
			colorSpaceConversion: 'none',
		});
		const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
		if (context === null) throw new Error('Chromium gave no 2D canvas context');
		context.drawImage(bitmap, 0, 0);
		return [...context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data].slice(0, 3);
	}, png.toString('base64'));
}

function luminance(rgb: readonly number[]): number {
	return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
		const c = (rgb[i] ?? 0) / 255;
		return sum + weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	}, 0);
}

/**
 * The text's contrast as painted: a swatch filled with the element's own text
 * colour against an empty swatch that shows only what lies beneath, both placed
 * inside the element so they sit under exactly the ancestors the text does.
 */
async function paintedContrast(element: Locator): Promise<number> {
	await element.evaluate((node) => {
		for (const swatch of ['ink', 'ground']) {
			const span = document.createElement('span');
			span.dataset.contrastSwatch = swatch;
			span.style.cssText = `display:inline-block;flex:none;width:8px;height:8px;${swatch === 'ink' ? 'background:currentColor;' : ''}`;
			node.append(span);
		}
		node.scrollIntoView({ block: 'center' });
	});
	const ink = luminance(await paintedPixel(element.locator('[data-contrast-swatch="ink"]')));
	const ground = luminance(await paintedPixel(element.locator('[data-contrast-swatch="ground"]')));
	await element.evaluate((node) => {
		for (const swatch of node.querySelectorAll('[data-contrast-swatch]')) swatch.remove();
	});
	return (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05);
}

/** Every ratio under 4.5:1, unrounded, so a failure names each element and its value. */
function belowAA(ratios: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(ratios)
			.filter(([, ratio]) => ratio < 4.5)
			.map(([name, ratio]) => [name, Math.floor(ratio * 1000) / 1000]),
	);
}

interface SocketProxy {
	push(payload: unknown): void;
}

/**
 * Relay the page's device socket, dropping the device's own `drop` broadcasts
 * (the test states them) and answering the `answer` RPCs client-side.
 */
async function proxySocket(
	page: Page,
	pageRpc: PageRpc,
	drop: readonly string[],
	answer: Readonly<Record<string, unknown>>,
): Promise<SocketProxy> {
	const pending: string[] = [];
	let send: ((message: string) => void) | null = null;
	await page.routeWebSocket(
		(url) => isBackendSocket(url) && url.pathname === '/ws',
		(socket) => {
			const server = socket.connectToServer();
			pageRpc.bindConnectionLifecycle(socket, server);
			socket.onMessage((message) => {
				const frame = parse(message);
				const path = Array.isArray(frame?.path) ? frame.path.join('.') : '';
				if (path in answer) {
					socket.send(JSON.stringify({ id: frame?.id, result: answer[path] }));
					return;
				}
				server.send(message);
			});
			server.onMessage((message) => {
				pageRpc.acceptServerMessage(message);
				const frame = parse(message);
				if (frame !== null && drop.some((type) => type in frame)) return;
				socket.send(message);
			});
			send = (message) => socket.send(message);
			for (const message of pending.splice(0)) send(message);
		},
	);
	return {
		push(payload) {
			const message = JSON.stringify(payload);
			if (send === null) pending.push(message);
			else send(message);
		},
	};
}

function parse(message: string | Buffer): Record<string, unknown> & { id?: unknown; path?: unknown[] } | null {
	try {
		const frame: unknown = JSON.parse(message.toString());
		return typeof frame === 'object' && frame !== null ? (frame as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function useScheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
	await page.emulateMedia({ colorScheme: scheme });
	await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), scheme);
}

async function expectScheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
	await (scheme === 'dark'
		? expect(page.locator('html')).toHaveClass(/\bdark\b/)
		: expect(page.locator('html')).not.toHaveClass(/\bdark\b/));
}

const FAILED_ADDON = {
	descriptor: {
		id: 'cloud-recorder',
		name: 'Cloud Recorder',
		version: '2.0.1',
		category: 'media',
		payload: { type: 'sysext' },
		sysextLevel: '1',
		versionId: '12',
		artifact: {
			urlTemplate: 'https://addons.ceralive.tv/{os_version}/cloud-recorder.raw',
			sha256: 'b'.repeat(64),
			gpgSigRef: 'rec.sig',
			sizeDownload: 9_000_000,
			sizeInstalled: 21_000_000,
		},
		provides: ['/usr/lib/ceralive/cloud-recorder'],
	},
	state: { enabled: true, phase: 'error', autoDisabled: false, lastError: 'addon_enable_failed' },
	managerPhase: 'failed',
};

/** A capture source the device reports as unplugged. */
function lostCapture(id: string, kind: string, pipelineId: string, displayName: string): Record<string, unknown> {
	return {
		origin: 'capture',
		id,
		pipelineId,
		kind,
		displayName,
		devicePath: `/dev/${id}`,
		modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: '1080p',
		defaultFramerate: 30,
		audioKind: 'none',
		available: true,
		lost: true,
	};
}

for (const scheme of ['dark', 'light'] as const) {
	test(`the Audio dialog's no-audio-support band reads at AA in ${scheme}`, async ({ page, pageRpc }) => {
		test.setTimeout(90_000);
		await useScheme(page, scheme);
		const device = await proxySocket(page, pageRpc, ['config', 'sources'], {});
		await page.goto('/');
		await ensureAuthenticated(page);
		await expectScheme(page, scheme);
		await navigateTo(page, 'live');
		device.push({
			config: { srtla_addr: '127.0.0.1', srtla_port: 5000, srt_streamid: 'e2e', max_br: 6000, pipeline: 'hdmi', source: 'hdmi' },
		});
		device.push({
			sources: {
				hardware: 'rk3588',
				sources: [
					{
						origin: 'coarse',
						id: 'hdmi',
						pipelineId: 'hdmi',
						labelKey: 'settings.sources.hdmi',
						modes: [],
						supportsAudio: false,
						supportsResolutionOverride: true,
						supportsFramerateOverride: true,
						available: true,
					},
				],
			},
		});

		const trigger = page.getByTestId('open-audio-dialog');
		await expect(trigger).toBeVisible({ timeout: 30_000 });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'Audio Settings' });
		const heading = dialog.getByRole('heading', { name: 'No audio settings supported' });
		const line = dialog.getByText("The selected pipeline doesn't support audio configuration");
		await expect(heading).toBeVisible();
		await expect(line).toBeVisible();

		expect(
			belowAA({
				heading: await paintedContrast(heading),
				line: await paintedContrast(line),
			}),
		).toEqual({});
	});

	test(`a failed add-on's badge and error line read at AA in ${scheme}`, async ({ page, pageRpc }) => {
		await useScheme(page, scheme);
		await proxySocket(page, pageRpc, [], { 'addons.list': { addons: [FAILED_ADDON] } });
		await page.goto('/');
		await ensureAuthenticated(page);
		await expectScheme(page, scheme);
		await navigateTo(page, 'settings');
		await page.getByRole('button', { name: /Add-ons/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Add-ons' });
		const badge = dialog.getByTestId('addon-badge-cloud-recorder');
		const error = dialog.getByTestId('addon-error-cloud-recorder');
		await expect(badge).toHaveText('Failed');
		await expect(error).toBeVisible();

		expect(
			belowAA({
				badge: await paintedContrast(badge),
				error: await paintedContrast(error),
			}),
		).toEqual({});
	});

	test(`an unplugged source's Lost badge reads at AA on its selected and unselected row in ${scheme}`, async ({
		page,
		pageRpc,
	}) => {
		test.setTimeout(90_000);
		await useScheme(page, scheme);
		const device = await proxySocket(page, pageRpc, ['config', 'sources'], {});
		await page.goto('/');
		await ensureAuthenticated(page);
		await expectScheme(page, scheme);
		await navigateTo(page, 'live');
		device.push({
			config: { srtla_addr: '127.0.0.1', srtla_port: 5000, srt_streamid: 'e2e', max_br: 6000, pipeline: 'hdmi', source: 'video0' },
		});
		device.push({
			sources: {
				hardware: 'rk3588',
				sources: [
					lostCapture('video0', 'hdmi', 'hdmi', 'HDMI Camera'),
					lostCapture('video1', 'usb', 'libuvch264', 'USB Capture'),
				],
			},
		});

		// Both rows stay unselectable; the selected one keeps its selection frame.
		await expect(page.getByTestId('source-row-video0')).toHaveAttribute('data-selected', 'true', { timeout: 30_000 });
		await expect(page.getByTestId('source-row-video1')).toHaveAttribute('data-selected', 'false');
		await expect(page.getByTestId('source-select-video0')).toBeDisabled();
		await expect(page.getByTestId('source-select-video1')).toBeDisabled();

		expect(
			belowAA({
				selected: await paintedContrast(page.getByTestId('source-lost-video0')),
				unselected: await paintedContrast(page.getByTestId('source-lost-video1')),
			}),
		).toEqual({});
	});
}
