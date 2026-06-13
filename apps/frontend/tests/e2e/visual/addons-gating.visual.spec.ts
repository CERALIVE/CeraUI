import fs from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { navigateTo } from '../helpers/index.js';

/**
 * Add-ons UI — board gating, conflict warnings, and the docs panel (@visual).
 *
 * In dev/emulated mode the backend ships no image-baked descriptors, so the
 * catalogue is empty. To exercise the gating/conflict/docs surfaces this spec
 * reuses the field-lock WebSocket harness pattern (addInitScript): it
 * authenticates with a real persistent token and drop+fakes the three reads the
 * AddonsSection makes on open —
 *   - addons.list             → two fabricated descriptors
 *   - streaming.getMockHardware → detected board = n100
 *   - addons.install          → a structured addon_conflict refusal
 * so the UI reflects the SERVER contract deterministically. Produces the two
 * evidence screenshots under CeraUI/test-results/.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(import.meta.dirname, '../../../../backend/auth_tokens.json');
	const tokens = Object.keys(JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<string, true>).filter(
		(t) => t !== 'placeholder',
	);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`);
	}
	return tokens[0] as string;
})();

// CeraUI/test-results — repo-local, gitignored (Rule D). visual → e2e → tests →
// frontend → apps → CeraUI is five levels up.
const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'test-results');

function evidencePath(name: string): string {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	return path.join(EVIDENCE_DIR, name);
}

/**
 * Browser-side harness. Serialized into the page via addInitScript; fully
 * self-contained except its `token` argument.
 */
function installAddonHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__ceraAddons) return;
	const Real = w.WebSocket;

	const idle = { enabled: false, phase: 'idle', autoDisabled: false };
	const descriptors = [
		{
			id: 'pip-overlay',
			name: 'HDMI PiP Overlay',
			version: '1.2.0',
			category: 'media',
			payload: { type: 'sysext' },
			sysextLevel: '1',
			versionId: '12',
			artifact: {
				urlTemplate: 'https://addons.ceralive.tv/{os_version}/pip-overlay.raw',
				sha256: 'a'.repeat(64),
				gpgSigRef: 'pip.sig',
				sizeDownload: 18_000_000,
				sizeInstalled: 42_000_000,
			},
			provides: ['/usr/lib/ceralive/pip-overlay'],
			compatibleHardware: ['rk3588'],
			docs: 'Composites the secondary HDMI input as a picture-in-picture overlay on the encoded program feed. Configure the inset corner and scale from the encoder settings once enabled. Requires the RK3588 hardware compositor.',
			helpUrl: 'https://docs.ceralive.tv/addons/pip-overlay',
		},
		{
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
			docs: 'Records the program feed to the bonded cloud bucket alongside the live stream.',
			helpUrl: 'https://docs.ceralive.tv/addons/cloud-recorder',
		},
	];

	const fakeResults: Record<string, unknown> = {
		'addons.list': {
			addons: descriptors.map((descriptor) => ({ descriptor, state: idle, managerPhase: 'disabled' })),
		},
		'streaming.getMockHardware': {
			hardware: null,
			effectiveHardware: 'n100',
			availableHardware: ['jetson', 'n100', 'rk3588', 'generic'],
		},
		'addons.install': { success: false, error: 'addon_conflict' },
	};

	w.__ceraAddons = { socket: null };

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__ceraAddons.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join('.') : null;

				if (p === 'auth.login') {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				if (p && p in fakeResults) {
					const id = msg.id;
					const result = fakeResults[p];
					setTimeout(
						() =>
							this.dispatchEvent(
								new MessageEvent('message', { data: JSON.stringify({ id, result }) }),
							),
						0,
					);
					return undefined;
				}
			} catch {
				/* not an RPC frame */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	try {
		localStorage.setItem('auth', 'e2e-token-marker');
	} catch {
		/* localStorage unavailable */
	}
}

async function openAddonsDialog(page: Page): Promise<void> {
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: /Add-ons/ }).click();
	await expect(page.getByRole('dialog', { name: 'Add-ons' })).toBeVisible();
	await expect(page.getByTestId('addon-card-pip-overlay')).toBeVisible();
}

test.describe('@visual Add-ons gating, conflict warnings, and docs', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'single-browser visual proof');

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the add-ons dialog');
		await page.addInitScript(installAddonHarness, TOKEN);
		await page.goto('/');
	});

	test('@visual incompatible add-on is disabled with a reason and exposes its docs', { tag: '@visual' }, async ({
		page,
	}) => {
		await openAddonsDialog(page);

		// Board gating: pip-overlay declares compatibleHardware:['rk3588'] but the
		// detected board is n100 → disabled with a visible reason (never hidden).
		const incompatibleSwitch = page.getByTestId('addon-switch-pip-overlay');
		await expect(incompatibleSwitch).toBeDisabled();
		const reason = page.getByTestId('addon-incompatible-pip-overlay');
		await expect(reason).toBeVisible();
		await expect(reason).toContainText('rk3588');
		await expect(reason).toContainText('n100');

		// Docs panel: expand the help affordance → descriptor docs + helpUrl.
		await page.getByTestId('addon-docs-toggle-pip-overlay').click();
		const docs = page.getByTestId('addon-docs-pip-overlay');
		await expect(docs).toBeVisible();
		await expect(docs).toContainText('picture-in-picture overlay');
		await expect(page.getByTestId('addon-helpurl-pip-overlay')).toHaveAttribute(
			'href',
			'https://docs.ceralive.tv/addons/pip-overlay',
		);

		await page
			.getByRole('dialog', { name: 'Add-ons' })
			.screenshot({ path: evidencePath('addons-gating-docs.png') });
	});

	test('@visual enabling a conflicting add-on surfaces a visible warning', { tag: '@visual' }, async ({
		page,
	}) => {
		await openAddonsDialog(page);

		// cloud-recorder is board-compatible; the backend refuses the enable with a
		// structured addon_conflict → a pinned warning, not a silent revert.
		const recorderSwitch = page.getByTestId('addon-switch-cloud-recorder');
		await expect(recorderSwitch).toBeEnabled();
		await recorderSwitch.click();

		const warning = page.getByTestId('addon-conflict-cloud-recorder');
		await expect(warning).toBeVisible();
		await expect(warning).toContainText('Conflicts');
		// Pessimistic: the failed enable reverts the toggle to off.
		await expect(recorderSwitch).toHaveAttribute('aria-checked', 'false');

		await page
			.getByRole('dialog', { name: 'Add-ons' })
			.screenshot({ path: evidencePath('addons-conflict.png') });
	});
});
