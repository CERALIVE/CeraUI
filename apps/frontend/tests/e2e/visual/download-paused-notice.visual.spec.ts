import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../fixtures/index.js';
import {
	ensureAuthenticated,
	evidencePath,
	setLocale,
	setTheme,
} from '../helpers/index.js';

function readCopy(raw: unknown) {
	if (typeof raw !== 'object' || raw === null)
		throw new TypeError('Invalid test catalog');
	const text = (key: string): string => {
		const value: unknown = Reflect.get(raw, key);
		if (typeof value !== 'string') throw new TypeError('Missing catalog text');
		return value;
	};
	return {
		'notifications.updatePausedForStream': text(
			'notifications.updatePausedForStream',
		),
		'notifications.openUpdates': text('notifications.openUpdates'),
		'settings.index.updates': text('settings.index.updates'),
	};
}
const locales = [
	'en',
	'es',
	'de',
	'fr',
	'hi',
	'ja',
	'ko',
	'pt-BR',
	'zh',
	'ar',
] as const;

for (const locale of locales) {
	const copy = readCopy(
		JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(
						`../../../../../packages/i18n/messages/${locale}.json`,
						import.meta.url,
					),
				),
				'utf8',
			),
		),
	);
	for (const theme of ['light', 'dark'] as const) {
		for (const width of [390, 1440] as const) {
			test.describe(`${locale} ${theme} ${width} download hold`, () => {
				test.use({
					viewport: { width, height: 900 },
					isMobile: width === 390,
					hasTouch: width === 390,
					deviceScaleFactor: width === 390 ? 3 : 1,
				});
				test('translated persistent panel, Updates action and dismissal @visual', async ({
					page,
					pageRpc,
				}) => {
					await page.goto('/');
					await ensureAuthenticated(page);
					await setLocale(page, locale);
					await setTheme(page, theme);
					await page.reload();
					await ensureAuthenticated(page);
					await expect(page.locator('html')).toHaveAttribute('lang', locale);
					const name =
						'update:download-paused:packages:11111111-1111-4111-8111-111111111111';
					await pageRpc.call(['dev', 'emit'], {
						type: 'notification',
						payload: {
							show: [
								{
									name,
									type: 'info',
									msg: 'notifications.updatePausedForStream',
									key: 'notifications.updatePausedForStream',
									params: {},
									is_dismissable: true,
									is_persistent: true,
									duration: 0,
									action: {
										schema: 1,
										kind: 'navigate',
										target: 'updates-dialog',
										labelKey: 'notifications.openUpdates',
									},
								},
							],
						},
					});
					await page.getByTestId('notifications-bell').click();
					const item = page
						.getByTestId('notification-item')
						.filter({ hasText: copy['notifications.updatePausedForStream'] });
					await expect(item).toBeVisible();
					await expect(item).toBeInViewport({ ratio: 1 });
					expect(
						await item.evaluate(
							(element) => element.scrollWidth <= element.clientWidth,
						),
					).toBe(true);
					await page.evaluate(async () => {
						await Promise.all(
							document
								.getAnimations()
								.filter(
									(animation) =>
										animation.effect?.getComputedTiming().iterations !==
										Number.POSITIVE_INFINITY,
								)
								.map((animation) => animation.finished.catch(() => undefined)),
						);
					});
					await page.screenshot({
						path: evidencePath(`dlp-${locale}-${theme}-${width}.png`),
						scale: 'css',
					});
					await item
						.getByRole('button', { name: copy['notifications.openUpdates'] })
						.click();
					const updates = page.getByRole('dialog', {
						name: copy['settings.index.updates'],
						exact: true,
					});
					await expect(updates).toBeVisible();
					await page.keyboard.press('Escape');
					await expect(updates).toBeHidden();
					await page.getByTestId('notifications-bell').click();
					await item.getByTestId('notification-dismiss').click();
					await expect(item).toHaveCount(0);
				});
			});
		}
	}
}
