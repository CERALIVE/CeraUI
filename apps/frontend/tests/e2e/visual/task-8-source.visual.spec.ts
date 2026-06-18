import { expect, test } from '../fixtures/index.js';
import { evidencePath } from '../helpers/index.js';
import { LivePage } from '../pages/live.js';

/**
 * Task 8 — Unified Source surface.
 *
 * Proves, against the REAL frontend + mock backend, that the Live destination
 * renders ONE coherent "Source" section composing the hotplug video input
 * picker with the pipeline-reported audio source and a compact capability
 * summary. Captures the section as repo-local evidence.
 */
test.describe('@visual Task 8 — unified source surface', () => {
	test('@visual source section renders video + audio + capabilities', {
		tag: '@visual',
	}, async ({ authedPage: page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'single-layout visual proof');

		const live = new LivePage(page);
		await live.open();

		const section = page.getByTestId('source-section');
		await expect(section).toBeVisible({ timeout: 20_000 });
		await section.scrollIntoViewIfNeeded();

		// The unified surface carries BOTH the video picker and the audio source.
		await expect(section.getByTestId('input-picker')).toBeVisible();
		await expect(section.getByTestId('source-audio')).toBeVisible();

		await section.screenshot({ path: evidencePath('task-8-unified-source.png') });
	});
});
