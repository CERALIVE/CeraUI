import { isBackendSocket } from "../helpers/backend-socket.js";

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';

/**
 * audio-mixer.visual.spec.ts — @visual baselines for the Audio card's mixer.
 *
 * Two states are worth pixels: the idle card (the main input's strip carrying
 * today's meter, a second input on Track 2, the others off) and the live card on
 * a mix session (switches and chips held for the next start). Both run on the
 * `caps-full` mock, whose meters have no main-socket level and so rest in their
 * static unavailable state. Desktop only (`@desktop-only`): mobile baselines are
 * not tracked (`.gitignore`), and the functional spec covers the phone layout. The backend also lists the sound cards of the
 * host it runs on, so the socket is proxied and the device list narrowed to
 * caps-full's three, keeping the pixels independent of the machine.
 */

test.use({ backendScenario: 'caps-full' });

const MAIN = 'RØDE AI-Micro';
const SECOND = 'Elgato Wave:3';
const MOCK_DEVICES = new Set([MAIN, SECOND, 'HDMI Input']);

type Frame = { [key: string]: unknown };

function narrowDevices(frame: Frame): void {
	const sources = frame.audio_sources;
	if (Array.isArray(sources)) {
		const host = new Set(
			sources
				.filter((s: { id: string; kind: string }) => s.kind === 'device' && !MOCK_DEVICES.has(s.id))
				.map((s: { id: string }) => s.id),
		);
		frame.audio_sources = sources.filter((s: { id: string }) => !host.has(s.id));
		if (Array.isArray(frame.asrcs)) frame.asrcs = frame.asrcs.filter((id: string) => !host.has(id));
	}
	for (const key of ['status', 'result']) {
		const nested = frame[key];
		if (nested !== null && typeof nested === 'object') narrowDevices(nested as Frame);
	}
}

async function installNarrowedSocket(
	page: Page,
	pageRpc: {
		bindConnectionLifecycle(browser: unknown, server: unknown): void;
		acceptServerMessage(message: string | Buffer): void;
	},
): Promise<void> {
	await page.routeWebSocket(isBackendSocket, (ws) => {
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			pageRpc.acceptServerMessage(message);
			if (typeof message !== 'string') {
				ws.send(message);
				return;
			}
			try {
				const frame = JSON.parse(message) as Frame;
				narrowDevices(frame);
				ws.send(JSON.stringify(frame));
			} catch {
				ws.send(message);
			}
		});
	});
}

async function idleWithTwoInputs(page: Page): Promise<void> {
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
	await page.getByTestId(`audio-strip-enable-${SECOND}`).click();
	await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute('aria-checked', 'true');
	await page.getByTestId(`audio-strip-track-${SECOND}-2`).click();
	await expect(page.getByTestId(`audio-strip-track-${SECOND}-2`)).toHaveAttribute('aria-pressed', 'true');
}

test.describe('@visual audio mixer', () => {
	test.beforeEach(async ({ page, pageRpc, backendRpc }) => {
		await backendRpc.call(['streaming', 'setConfig'], {
			asrc: MAIN,
			source: 'usb',
			srtla_addr: '127.0.0.1',
			srtla_port: 5000,
		});
		await installNarrowedSocket(page, pageRpc);
	});

	test('@visual idle — strips under the picker', { tag: ['@visual', '@desktop-only'] }, async ({ page }) => {
		// The 689 px card cannot fit between the 57 px sticky header and the 75 px Live
		// bar at the desktop project's 800 px: a taller window keeps it all on screen.
		await page.setViewportSize({ width: 1280, height: 900 });
		await idleWithTwoInputs(page);
		const card = page.getByTestId('idle-cockpit').getByTestId('audio-card');
		await expect(card.getByTestId('audio-mixer')).toBeVisible();
		// Frame the card from its top, just under the sticky header, so every run
		// captures the same pixels and the whole card clears both pinned bars.
		const frame = await card.evaluate((element) => {
			const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
			window.scrollBy({ top: element.getBoundingClientRect().top - header - 16, behavior: 'instant' });
			const box = element.getBoundingClientRect();
			const bar = document.querySelector('[data-testid="live-bar"]')?.getBoundingClientRect().top ?? innerHeight;
			return { top: box.top, bottom: box.bottom, header, bar };
		});
		expect(frame.top, 'the Audio card starts under the sticky header').toBeGreaterThanOrEqual(frame.header);
		expect(frame.bottom, 'the Audio card ends above the Live bar').toBeLessThanOrEqual(frame.bar);
		// The snapshot must show the heading row: nothing on screen may cover the
		// heading, its help or Codec & delay when the card is captured.
		for (const target of [card.locator('#live-audio-card-title'), card.getByTestId('info-audio'), card.getByTestId('open-audio-dialog')]) {
			const uncovered = await target.evaluate((element) => {
				const box = element.getBoundingClientRect();
				const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
				return hit !== null && (hit === element || element.contains(hit));
			});
			expect(uncovered, 'the Audio heading row is covered when the card is captured').toBe(true);
		}
		await expect(card).toHaveScreenshot('audio-mixer-idle.png', { maxDiffPixels: 100 });
	});

	test('@visual live — a mix session', { tag: ['@visual', '@desktop-only'] }, async ({ page }) => {
		await idleWithTwoInputs(page);
		await page.getByTestId('live-bar').getByRole('button', { name: 'Start stream' }).click();
		const card = page.getByTestId('live-cockpit').getByTestId('audio-card');
		await expect(card.getByTestId('audio-mixer-next-start')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId(`audio-strip-gain-${MAIN}`).getByRole('slider')).toBeEnabled();
		// The idle-to-live swap leaves a timing-dependent scroll offset; frame the card
		// from its top so every run captures the same pixels.
		await card.evaluate((element) => element.scrollIntoView({ block: 'start' }));
		await expect(card).toHaveScreenshot('audio-mixer-live.png', { maxDiffPixels: 100 });
		await page.getByTestId('live-bar').getByRole('button', { name: 'Stop stream' }).click();
	});
});
