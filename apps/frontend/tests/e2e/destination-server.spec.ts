/**
 * Destination-first ServerDialog — functional e2e (Task 15).
 *
 * The receiver-experience overhaul (T9) rebuilt ServerDialog to lead with WHERE
 * the stream is sent (a destination radiogroup: managed cloud account vs. custom
 * receiver). T21 then promoted the transport-protocol radiogroup to an
 * always-visible primary control ABOVE the endpoint section (no Advanced
 * disclosure). This spec drives the REAL dev backend
 * (MOCK_SCENARIO=multi-modem-wifi) through both destination paths and locks the
 * destination-first contract:
 *
 *   • managed — pick "My cloud account", select a seeded relay server (RTT badge),
 *     save; the Live header chip flips to the managed destination + transport.
 *   • custom  — pick "Custom receiver", fill addr/port/streamid, Validate (now
 *     deterministic via the T4 mock seam — assert a PASS and a forced FAIL), save;
 *     the Live header chip reflects the custom endpoint + transport.
 *   • transport-first DOM order — `[data-testid=transport-protocol]` is present on
 *     open and precedes #srtla-addr (the promoted-above-endpoint contract).
 *   • RIST — capability-enabled, selectable from the always-visible radiogroup,
 *     persists across a reload (ported from the retired transport-protocol.spec).
 *   • mobile Sheet — both cards visible + ≥44px touch targets + Save reachable.
 *
 * The forced-fail is produced by a WS route that rewrites ONLY the
 * `relay.validate` response to a failing stage — the dialog hard-codes
 * `protocol:'srtla'` for validate, and the mock seam returns a pass for every
 * well-formed srtla endpoint, so a deterministic failure cannot be produced
 * through the inputs alone. There is no `dev.*` setter for the validate fault, so
 * the response rewrite is the seam-free way to exercise the failure branch.
 *
 * Conventions (PLAYBOOK.md): assert via roles/test-ids/ARIA, never screenshots
 * (those live in destination-server.visual.spec.ts); no fixed-delay waits — every
 * async wait is a web-first assertion. Evidence → repo-local test-results/.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo } from './helpers/index.js';

async function openServerDialog(page: Page) {
	await navigateTo(page, 'live');
	const byTestId = page.getByTestId('open-server-dialog');
	if ((await byTestId.count()) > 0) {
		await byTestId.first().click();
	} else {
		await page.getByRole('button', { name: 'Edit Settings' }).first().click();
	}
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(path.join('task-15', fileName));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

test.describe('destination-first ServerDialog — desktop flows', () => {
	// These tests persist config, but each Playwright worker now owns an isolated
	// mock backend (own config.json), so they run in parallel without racing.

	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser integration proof');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the dialog');
	});

	test('managed: pick cloud account, select seeded server, save → Live reflects managed', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// Managed enables once the mock relay catalog populates (4 servers).
		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(managed).toHaveAttribute('aria-checked', 'true');

		// The managed body renders the relay-server selector.
		const serverSelect = dialog.locator('#relay-server');
		await expect(serverSelect).toBeVisible();

		// Select the first seeded server via the real Select UI.
		await serverSelect.click();
		await page.getByRole('option').first().click();

		// The selected server surfaces its RTT tier badge.
		await expect(dialog.locator('#relay-server [data-rtt-tier]')).toBeVisible();

		// The auto-preloaded endpoint renders READ-ONLY (an <output>), not the
		// empty placeholder, once a server is chosen.
		const endpoint = dialog.locator('#relay-endpoint');
		await expect(endpoint).toBeVisible();
		await expect(endpoint).not.toHaveText('—');

		// Manual override reveals editable host/port and hides the read-only
		// endpoint; toggle back to auto before saving as a managed relay.
		const override = dialog.getByRole('switch', { name: 'Manual override' });
		await override.click();
		await expect(override).toHaveAttribute('aria-checked', 'true');
		await expect(dialog.locator('#relay-override-addr')).toBeVisible();
		await expect(endpoint).toHaveCount(0);
		await override.click();
		await expect(endpoint).toBeVisible();

		// Save (managed needs only a selected server) and assert the Live chip.
		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(dialog).toBeHidden();

		// The destination is the deterministic "Live reflects it" signal. The
		// transport badge (SRTLA/RIST) is NOT asserted: the managed save persists
		// whatever relay_protocol the shared backend currently carries, which
		// sibling specs may have set — only the destination is owned by this flow.
		const chip = page.getByTestId('live-server-chip');
		await expect(chip).toHaveAttribute('data-destination', 'managed', { timeout: 10_000 });
		const chipText = (await page.getByTestId('live-server-chip-text').textContent())?.trim();

		writeEvidence('managed-flow.txt', [
			'Task 15 — managed destination flow',
			'',
			'destination-managed enabled after catalog populate, selected first seeded server.',
			'RTT tier badge rendered on the trigger; auto endpoint shown read-only.',
			'Manual override toggled host/port editable then back to auto.',
			'Saved → Live header chip data-destination="managed".',
			`chip text: ${chipText}`,
		]);
	});

	test('transport-first: transport-protocol radiogroup is present on open and precedes #srtla-addr', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		// Custom is always available — a stable starting point independent of the
		// shared backend's persisted destination.
		await dialog.getByTestId('destination-custom').click();

		// T21: the radiogroup is promoted above the endpoint — present on open,
		// with no Advanced disclosure to expand.
		const group = page.locator('[data-testid=transport-protocol]');
		await expect(group).toHaveCount(1);
		await expect(dialog.getByRole('button', { name: 'Advanced' })).toHaveCount(0);

		// DOM order: the radiogroup precedes the custom endpoint address field.
		const order = await page.evaluate(() => {
			const grp = document.querySelector('[data-testid=transport-protocol]');
			const addr = document.getElementById('srtla-addr');
			if (!grp || !addr) return null;
			return Boolean(
				grp.compareDocumentPosition(addr) & Node.DOCUMENT_POSITION_FOLLOWING,
			);
		});
		expect(order).toBe(true);

		writeEvidence('transport-first-order.txt', [
			'Task 15 / T21 — transport-first DOM order',
			'',
			'[data-testid=transport-protocol] present on open (count 1), no Advanced trigger.',
			`Radiogroup precedes #srtla-addr in DOM order = ${order} (expect true)`,
		]);
	});

	test('reserved plain-SRT renders as an inert coming-soon cell, never an enabled radio (T23)', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		// Reserved plain-SRT must be inert: not a radio, not a <button>. The two
		// real protocols ARE radios — the contrast is the contract.
		const srt = dialog.getByTestId('protocol-srt');
		await expect(srt).toHaveCount(1);
		await expect(srt).not.toHaveRole('radio');
		const srtTag = await srt.evaluate((el) => el.tagName);
		expect(srtTag).not.toBe('BUTTON');
		await expect(dialog.getByTestId('protocol-srtla')).toHaveRole('radio');
		await expect(dialog.getByTestId('protocol-rist')).toHaveRole('radio');

		// Bound to the open tech-debt entry, with no clickable control inside.
		await expect(srt.locator('[data-debt-id="TD-plain-srt-egress"]')).toHaveCount(1);
		await expect(srt.locator('button')).toHaveCount(0);

		writeEvidence('reserved-srt-coming-soon.txt', [
			'Task 23 — reserved plain-SRT is an inert coming-soon cell',
			'',
			`protocol-srt tagName = ${srtTag} (expect not BUTTON), role != radio.`,
			'SRTLA + RIST cells ARE role=radio for contrast.',
			'Carries data-debt-id="TD-plain-srt-egress"; no <button> inside (non-interactive).',
		]);
	});

	test('RIST↔SRTLA switching reshapes the custom endpoint fields reactively (T23)', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const passphrase = dialog.locator('#srtla-passphrase');
		const evenPortHint = dialog.getByTestId('rist-even-port-hint');
		const addressLabel = dialog.locator('label[for="srtla-addr"]');

		// SRTLA (default custom kind): SRT-family secret present, no even-port hint.
		await expect(passphrase).toBeVisible();
		await expect(evenPortHint).toHaveCount(0);
		const srtlaAddressLabel = (await addressLabel.textContent())?.trim() ?? '';

		// RIST simple-profile has no passphrase, requires an even port, and uses
		// point-to-point receiver naming — the form must re-derive from the kind.
		const rist = dialog.getByTestId('protocol-rist');
		await expect(rist).toBeEnabled({ timeout: 15_000 });
		await rist.click();
		await expect(rist).toHaveAttribute('aria-checked', 'true');
		await expect(passphrase).toHaveCount(0);
		await expect(evenPortHint).toBeVisible();
		const ristAddressLabel = (await addressLabel.textContent())?.trim() ?? '';
		expect(ristAddressLabel).not.toBe(srtlaAddressLabel);

		// Reverting the protocol reverts the field set in lock-step.
		const srtla = dialog.getByTestId('protocol-srtla');
		await srtla.click();
		await expect(srtla).toHaveAttribute('aria-checked', 'true');
		await expect(passphrase).toBeVisible();
		await expect(evenPortHint).toHaveCount(0);
		await expect(addressLabel).toHaveText(srtlaAddressLabel);

		writeEvidence('protocol-field-reshape.txt', [
			'Task 23 — RIST↔SRTLA reactive field reshape (custom endpoint)',
			'',
			`SRTLA: #srtla-passphrase visible, no even-port hint, address label "${srtlaAddressLabel}".`,
			`RIST:  #srtla-passphrase gone, even-port hint visible, address label "${ristAddressLabel}".`,
			'Back to SRTLA: secret returns, hint gone, label reverts — fields track the protocol.',
		]);
	});

	test('custom: validate PASS (mock seam) + forced FAIL (ws rewrite), save → Live reflects custom', async ({
		page,
	}) => {
		// Two WS rewrites, both keeping the real backend in the loop:
		//  • client→server: when armed, answer relay.validate with a failing stage.
		//  • server→client: strip relay_server from every config frame so this page
		//    is deterministically the CUSTOM destination. The frontend config merge
		//    only SETS fields (never clears on an absent key — a documented
		//    managed→custom limitation), and the shared mock backend is mutated by
		//    sibling specs, so without this the chip could read a stale relay_server.
		let forceFail = false;
		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => {
				const text = typeof m === 'string' ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { id?: string; path?: unknown };
					if (
						forceFail &&
						Array.isArray(frame.path) &&
						frame.path.join('.') === 'relay.validate' &&
						typeof frame.id === 'string'
					) {
						ws.send(
							JSON.stringify({
								id: frame.id,
								result: { valid: false, stage: 'dns', reason: 'Forced fault (e2e)' },
							}),
						);
						return;
					}
				} catch {
					/* non-JSON / keepalive frame */
				}
				server.send(m);
			});
			server.onMessage((m) => {
				const text = typeof m === 'string' ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { config?: Record<string, unknown> };
					if (frame.config && typeof frame.config === 'object') {
						delete frame.config.relay_server;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / keepalive frame */
				}
				ws.send(m);
			});
		});

		await page.goto('/');
		await ensureAuthenticated(page);

		const dialog = await openServerDialog(page);
		const custom = dialog.getByTestId('destination-custom');
		await custom.click();
		await expect(custom).toHaveAttribute('aria-checked', 'true');

		await dialog.locator('#srtla-addr').fill('10.20.30.40');
		await dialog.locator('#srtla-port').fill('7777');
		await dialog.locator('#srt-streamid').fill('e2e-custom');

		const stages = dialog.getByTestId('validate-stages');
		const okChip = stages.locator('[data-stage="ok"]');
		const dnsChip = stages.locator('[data-stage="dns"]');
		const validateBtn = dialog.locator('#relay-validate');

		// PASS — real backend mock seam resolves a well-formed srtla endpoint.
		await validateBtn.click();
		await expect(dialog.getByText('Endpoint reachable')).toBeVisible({ timeout: 15_000 });
		await expect(okChip).toHaveAttribute('data-status', 'done');

		// FORCED FAIL — the WS rewrite returns a failing dns stage.
		forceFail = true;
		await validateBtn.click();
		const failure = dialog.getByRole('alert');
		await expect(failure).toContainText('Validation failed', { timeout: 15_000 });
		await expect(failure).toContainText('dns');
		await expect(dnsChip).toHaveAttribute('data-status', 'failed');
		await expect(okChip).toHaveAttribute('data-status', 'pending');
		// A failed validation blocks Save until corrected.
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

		// Re-editing the address resets validation to idle; Save is allowed with
		// an idle (never-run) validation — no round-trip required.
		forceFail = false;
		await dialog.locator('#srtla-addr').fill('10.20.30.40');
		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(dialog).toBeHidden();

		const chip = page.getByTestId('live-server-chip');
		await expect(chip).toHaveAttribute('data-destination', 'custom', { timeout: 10_000 });
		await expect(page.getByTestId('live-server-chip-text')).toContainText('10.20.30.40:7777');

		writeEvidence('custom-flow.txt', [
			'Task 15 — custom destination flow (deterministic validate)',
			'',
			'PASS: relay.validate via T4 mock seam → "Endpoint reachable", ok chip done.',
			'FORCED FAIL: ws-rewritten relay.validate → dns stage failed, alert names "dns",',
			'             Save disabled while validation state is fail.',
			'Re-edit addr → idle validation → Save enabled (idle save allowed).',
			'Saved → Live header chip data-destination="custom", text contains "10.20.30.40:7777".',
			`chip text: ${(await page.getByTestId('live-server-chip-text').textContent())?.trim()}`,
		]);
	});

	test('RIST is selectable from the always-visible radiogroup (capability-enabled) and persists across a reload', async ({
		authedPage: page,
	}) => {
		let dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const rist = dialog.getByTestId('protocol-rist');
		await expect(rist).toBeEnabled({ timeout: 15_000 });
		await rist.click();
		await expect(rist).toHaveAttribute('aria-checked', 'true');

		// The RIST kind surfaces the even-port hint in the custom form.
		await expect(dialog.getByTestId('rist-even-port-hint')).toBeVisible();

		await dialog.locator('#srtla-addr').fill('10.50.60.70');
		await dialog.locator('#srtla-port').fill('5000');
		await dialog.locator('#srt-streamid').fill('e2e-rist');

		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(dialog).toBeHidden();

		// Reload + re-auth; the persisted protocol re-opens with RIST selected.
		await page.reload();
		await ensureAuthenticated(page);

		dialog = await openServerDialog(page);
		await expect(dialog.getByTestId('protocol-rist')).toHaveAttribute('aria-checked', 'true');
	});
});

test.describe('destination-first ServerDialog — mobile Sheet', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser integration proof');
		test.skip(testInfo.project.name !== 'mobile', 'mobile Sheet viewport (390×844)');
	});

	test('both destination cards visible, ≥44px touch targets, Save reachable after custom form', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// AppDialog renders a bottom Sheet (not a centered Dialog) on mobile.
		await expect(page.locator("[data-slot='sheet-content']")).toBeVisible();

		const managed = dialog.getByTestId('destination-managed');
		const custom = dialog.getByTestId('destination-custom');
		await expect(managed).toBeVisible();
		await expect(custom).toBeVisible();

		// Both destination cards meet the 44px minimum touch target.
		const heights: Record<string, number> = {};
		for (const [name, card] of [
			['managed', managed],
			['custom', custom],
		] as const) {
			const box = await card.boundingBox();
			expect(box, `${name} card has a bounding box`).not.toBeNull();
			heights[name] = Math.round(box?.height ?? 0);
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}

		// Fill the custom form, then prove Save is reachable (scrollable into view).
		await custom.click();
		await dialog.locator('#srtla-addr').fill('10.0.0.9');
		await dialog.locator('#srtla-port').fill('5000');

		const save = dialog.getByRole('button', { name: 'Save' });
		await save.scrollIntoViewIfNeeded();
		await expect(save).toBeInViewport();
		await expect(save).toBeEnabled();

		writeEvidence('mobile-sheet.txt', [
			'Task 15 — mobile Sheet functional assertion (390×844)',
			'',
			'AppDialog rendered the bottom Sheet ([data-slot=sheet-content]).',
			'Both destination cards visible with ≥44px touch targets:',
			`  destination-managed height = ${heights.managed}px (expect ≥44)`,
			`  destination-custom  height = ${heights.custom}px (expect ≥44)`,
			'After filling the custom form, Save scrolled into view, in viewport, enabled.',
		]);
	});
});
