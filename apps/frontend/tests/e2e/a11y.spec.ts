import fs from 'node:fs';
import path from 'node:path';

import { hudStructure } from './helpers/aria.js';
import { runAxe, type AxeViolationSummary } from './helpers/axe.js';
import { type Destination, navigateTo } from './helpers/index.js';
import { expect, test } from './fixtures/index.js';
import { SYSTEM_LOGS_DIALOG, SystemLogsPage } from './pages/system-logs.js';

/**
 * axe-core a11y CI gate (Task 7).
 *
 * Runs axe on each authenticated destination, gates ONLY on critical/serious
 * impact, and baselines pre-existing violations via a per-page rule-id allowlist
 * (`a11y-baseline.json`). A NEW critical/serious rule on a covered page fails the
 * build; pre-existing ones are reported but tolerated.
 *
 * Capture/refresh the baseline allowlist (and the baseline evidence doc) with:
 *   UPDATE_A11Y_BASELINE=1 bun run --filter frontend test:e2e -- \
 *     a11y.spec.ts --project=desktop -g "axe gate"
 *
 * Evidence lands in the repo-root `test-results/` (gitignored) per Task 7:
 *   - capture mode → test-results/task-7-a11y-baseline.json
 *   - gate mode    → test-results/task-7-a11y-gate.json
 */

// e2e -> tests -> frontend -> apps -> CeraUI (repo root). Evidence is repo-local
// (gitignored); never written above the checkout root (root AGENTS.md Rule D).
const REPO_TEST_RESULTS = path.resolve(import.meta.dirname, '../../../../test-results');
const BASELINE_ALLOWLIST = path.resolve(import.meta.dirname, 'a11y-baseline.json');

const PAGES: Destination[] = ['live', 'network', 'settings'];
const CAPTURE = process.env.UPDATE_A11Y_BASELINE === '1';

type Allowlist = Record<string, string[]>;

function readAllowlist(): Allowlist {
	const raw = JSON.parse(fs.readFileSync(BASELINE_ALLOWLIST, 'utf8')) as Allowlist;
	return raw;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Serial + desktop-only: one worker owns the shared evidence/allowlist files, so
// there is no concurrent-write race on them.
test.describe.configure({ mode: 'serial' });

test.describe('a11y', () => {
	test('axe gate: no new critical/serious violations @a11y', async ({ authedPage: page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'a11y gate runs once, on desktop');

		const allowlist = CAPTURE ? {} : readAllowlist();
		const perPage: Record<string, AxeViolationSummary[]> = {};
		const newViolations: Record<string, AxeViolationSummary[]> = {};

		for (const dest of PAGES) {
			await navigateTo(page, dest);
			// The persistent HUD region is the stable authed-shell signal — present in
			// every destination, before and after the skip-link/aria-live changes.
			await expect(page.locator('[data-hud-region]').first()).toBeVisible();

			const found = await runAxe(page);
			perPage[dest] = found;

			const allowed = new Set(allowlist[dest] ?? []);
			const fresh = found.filter((v) => !allowed.has(v.id));
			if (fresh.length > 0) newViolations[dest] = fresh;
		}

		const evidence = {
			generatedAt: new Date().toISOString(),
			mode: CAPTURE ? 'baseline-capture' : 'gate',
			gatedImpacts: ['critical', 'serious'],
			coveredPages: PAGES,
			violationsByPage: perPage,
			newViolations,
		};
		writeJson(
			path.join(REPO_TEST_RESULTS, CAPTURE ? 'task-7-a11y-baseline.json' : 'task-7-a11y-gate.json'),
			evidence,
		);

		if (CAPTURE) {
			const refreshed: Allowlist = {};
			for (const dest of PAGES) {
				refreshed[dest] = [...new Set((perPage[dest] ?? []).map((v) => v.id))].sort();
			}
			writeJson(BASELINE_ALLOWLIST, refreshed);
			return;
		}

		expect(
			newViolations,
			`New critical/serious a11y violations on covered pages:\n${JSON.stringify(newViolations, null, 2)}`,
		).toEqual({});
	});

	test('skip-to-content link jumps focus past the chrome to <main> @a11y', async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'skip-link assertion runs once, on desktop');

		await navigateTo(page, 'live');

		// The skip link is the first focusable element and is visually hidden until
		// focused. Tabbing from the document start reveals and activates it.
		await page.keyboard.press('Tab');
		const skipLink = page.getByRole('link', { name: /skip to (main )?content/i });
		await expect(skipLink).toBeFocused();
		await expect(skipLink).toBeVisible();

		await skipLink.press('Enter');

		const main = page.locator('#main-content');
		await expect(main).toBeVisible();
		await expect(main).toBeFocused();
	});

	// System Logs has no a11y-baseline.json entry: each view is analysed alone and held to zero.
	for (const view of ['events', 'raw', 'storage'] as const) {
		test(`System Logs ${view}: no critical or serious violations in either theme @a11y`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'a11y gate runs once, on desktop');

			const found: Record<string, AxeViolationSummary[]> = {};
			for (const scheme of ['dark', 'light'] as const) {
				const logs = new SystemLogsPage(page);
				// Below 1024 px Storage is its own tab; wider it is the side column beside Events and Raw logs.
				const size = view === 'storage' ? { width: 768, height: 1024 } : { width: 1280, height: 800 };
				await logs.open({ locale: 'en', size, touch: false, scheme });
				await logs.show(view);
				found[scheme] = await runAxe(page, { include: [SYSTEM_LOGS_DIALOG] });
			}
			expect(found).toEqual({ dark: [], light: [] });
		});
	}

	for (const { locale, scheme } of [
		{ locale: 'en', scheme: 'light' },
		{ locale: 'ar', scheme: 'light' },
		{ locale: 'ar', scheme: 'dark' },
		{ locale: 'ja', scheme: 'light' },
	] as const) {
		test(`System Logs storage: no critical or serious violations inline (${locale}, ${scheme}) @a11y`, async ({
			page,
		}, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'a11y gate runs once, on desktop');

			const logs = new SystemLogsPage(page);
			await logs.open({ locale, scheme, size: { width: 1024, height: 600 }, touch: false });
			await logs.show('storage');

			// Storage must be visible alongside Events and Raw, not as a third tab.
			await expect(page.locator(SYSTEM_LOGS_DIALOG).getByRole('tab')).toHaveCount(2);
			const theme = expect(page.locator('html'));
			if (scheme === 'dark') await theme.toHaveClass(/\bdark\b/);
			else await theme.not.toHaveClass(/\bdark\b/);

			expect(await runAxe(page, { include: [SYSTEM_LOGS_DIALOG] })).toEqual([]);
		});
	}

	test('HUD telemetry exposes labelled badges + polite live regions @a11y', async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'telemetry-region assertion runs once');

		await navigateTo(page, 'live');

		const status = page.locator('[data-testid="hud-telemetry-status"]');
		await expect(status).toHaveAttribute('role', 'status');
		await expect(status).toHaveAttribute('aria-live', 'polite');
		// A debounced summary settles to non-empty text once telemetry arrives.
		await expect.poll(async () => (await status.textContent())?.trim().length ?? 0).toBeGreaterThan(0);

		const hud = await hudStructure(page);
		// The bitrate badge carries an accessible name (value + staleness state),
		// not just a visual glyph — assistive tech reads the same telemetry.
		await expect(hud.getByRole('img', { name: /bitrate/i })).toBeVisible();

		// A second polite region announces only critical transitions (start/stop/drop).
		const transition = page.locator('[data-testid="hud-transition-status"]').first();
		await expect(transition).toHaveAttribute('role', 'status');
		await expect(transition).toHaveAttribute('aria-live', 'polite');
	});
});
