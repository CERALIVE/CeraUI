/**
 * Network rows share ONE anatomy, measured in the browser.
 *
 * Every link row on the Network destination (Wi-Fi, Cellular, Ethernet) is the
 * shared `NetworkRow`, so the same geometry holds in every section, at every
 * width and in every locale. Each assertion collects machine values (boxes,
 * contrast ratios, scroll widths) and expects no violation; no copy is pinned.
 *
 * Beyond the anatomy: names stay whole across the whole destination (Bonded Links
 * included), Tab follows the reading order at every width, a checked switch keeps
 * its thumb inside the track in Arabic, and an active hotspot reads hotspot.
 *
 * Fixture: the reference mock, with its device frames patched at the page WS so
 * the rows that are off in the mock render too — a hotspot radio, a paired
 * Bluetooth mic, an active sharing zone, and 32-character names with no spaces,
 * which prove that names WRAP rather than merely fit.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { btMicPairedStatus } from './helpers/bluetooth-wire.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { measureHitAreas } from './helpers/hit-area.js';
import { navigateTo, setLocale, setTheme } from './helpers/index.js';
import { healthyThreeUplinks, SHARED_LAN_IFNAME, withSharedLan } from './helpers/sharing-wire.js';

const STATION_SSID = 'CeraLiveFieldUplinkNetwork5GHzXY';
const HOTSPOT_SSID = 'CeraLiveBroadcastHotspotForCrew1';
const BT_DEVICE = 'JabraTalk65HeadsetForFieldCrew01';
const BT_ADAPTER = 'CeraLiveDeviceBluetoothAdapter01';
const UPLINK_NAME = 'CeraLiveQuectelRM530NGLModem0001';

/** Two links on one subnet, and a bond the sender ran with a collision excluded. */
const SHARED_SUBNET = '192.168.1.0/24';
const BOND_COLLISION = {
	state: 'degraded',
	reason: 'hash_mismatch',
	disposition: 'startup_collision_excluded',
	collisions: [{ ip: '192.168.1.100', effective_index: 0, excluded_indices: [2] }],
	source: 'sender',
};

const ROW_BUTTONS = [
	'modem-details-toggle',
	'open-modem-config-dialog',
	'open-netif-dialog',
	'open-wifi-selector-dialog',
	'open-wifi-mode',
];

type Radio = Record<string, unknown> & { available?: { active?: boolean; ssid?: string }[] };

function patchWifi(radios: Record<string, Radio>): Record<string, Radio> {
	const entries = Object.entries(radios);
	return Object.fromEntries(
		entries.map(([id, radio], index) => {
			if (index === 0) {
				return [
					id,
					{
						...radio,
						available: (radio.available ?? []).map((n) =>
							n.active ? { ...n, ssid: STATION_SSID } : n,
						),
					},
				];
			}
			const { available: _available, ...rest } = radio;
			return [
				id,
				{
					...rest,
					mode: 'hotspot',
					hotspot: { name: HOTSPOT_SSID, available_channels: { auto: { name: 'Auto' } } },
				},
			];
		}),
	);
}

function patchFrame(frame: Record<string, unknown>, throughput: number, collision: boolean): Record<string, unknown> {
	let next = frame;
	if (collision && next.status) {
		next = { ...next, status: { ...(next.status as object), bond_mapping: BOND_COLLISION } };
	}
	if (collision && next.netif) {
		const netif = next.netif as Record<string, object>;
		next = {
			...next,
			netif: Object.fromEntries(
				Object.entries(netif).map(([name, entry]) => [
					name,
					name === 'eth0' || name === 'wlan0' ? { ...entry, same_subnet_group: SHARED_SUBNET } : entry,
				]),
			),
		};
	}
	const status = next.status as { wifi?: Record<string, Radio> } | undefined;
	if (status?.wifi) next = { ...next, status: { ...status, wifi: patchWifi(status.wifi) } };
	// The HUD reports a link's `tp` only while a stream runs, so real totals need one.
	if (status && throughput > 0) {
		next = { ...next, status: { ...(next.status as object), is_streaming: true } };
	}
	const shared = withSharedLan(next, SHARED_LAN_IFNAME);
	if (shared) {
		const netif = shared.netif as Record<string, { enabled?: boolean; tp?: number }>;
		next = {
			...shared,
			netif: Object.fromEntries(
				Object.entries(netif).map(([name, entry]) => [
					name,
					entry.enabled ? { ...entry, tp: throughput } : entry,
				]),
			),
		};
	}
	return next;
}

/** Patch the live frames and own the topics the mock cannot produce. Before any navigation. */
async function installRowFixture(page: Page, throughput = 0, collision = false): Promise<() => void> {
	let route: WebSocketRoute | null = null;
	const owned = ['bluetooth', 'uplinks', 'uplink-steering', 'uplink-shaper'];
	await page.routeWebSocket(isBackendSocket, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const text = typeof message === 'string' ? message : message.toString();
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(text) as Record<string, unknown>;
			} catch {
				ws.send(message);
				return;
			}
			if (owned.some((topic) => topic in parsed)) return;
			ws.send(JSON.stringify(patchFrame(parsed, throughput, collision)));
		});
	});
	return () => {
		const sharing = healthyThreeUplinks();
		const bt = btMicPairedStatus();
		bt.devices = bt.devices.map((d) => ({ ...d, name: BT_DEVICE }));
		bt.adapters = bt.adapters.map((a) => ({ ...a, name: BT_ADAPTER }));
		route?.send(JSON.stringify({ bluetooth: bt }));
		const uplinks = sharing.uplinks.map((u, i) => (i === 0 ? { ...u, displayName: UPLINK_NAME } : u));
		route?.send(JSON.stringify({ uplinks }));
		route?.send(JSON.stringify({ 'uplink-steering': sharing.steering }));
		route?.send(JSON.stringify({ 'uplink-shaper': sharing.shaper }));
	};
}

async function openNetwork(page: Page, locale: string, throughput = 0, collision = false): Promise<void> {
	const publish = await installRowFixture(page, throughput, collision);
	await setLocale(page, locale);
	await page.reload();
	await navigateTo(page, 'network');
	publish();
	await expect(page.getByTestId('modem-row')).toHaveCount(5);
	await expect(page.getByTestId('bluetooth-device')).toBeVisible();
	await expect(page.getByText(HOTSPOT_SSID).first()).toBeVisible();
	await expect(page.getByTestId('sharing-uplinks')).toBeVisible();
	await expect(page.getByText(UPLINK_NAME)).toBeVisible();
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Resize, then wait for the CSS transitions the new breakpoint starts (a button's min-height grows to 44px). */
async function atWidth(page: Page, width: number, height = 800): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.evaluate(async () => {
		await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
		await Promise.all(
			document
				.getAnimations()
				.filter((a) => a instanceof CSSTransition)
				.map((a) => a.finished.catch(() => undefined)),
		);
	});
}

/** Checks 7, 8 and 12: the row geometry, as a list of violations. */
function rowGeometry(): string[] {
	const visible = (el: Element): boolean => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
	};
	const hit = (p: DOMRect, q: DOMRect): boolean =>
		Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 &&
		Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1;
	const folded = (el: Element): boolean =>
		Boolean(el.closest('[data-testid="modem-details-body"], details:not([open]) > :not(summary)'));
	const out: string[] = [];
	const switchX: string[] = [];
	const xs: number[] = [];
	for (const row of document.querySelectorAll<HTMLElement>('[data-net-row]')) {
		const id = row.dataset.ifname ?? row.dataset.device ?? row.dataset.testid ?? '?';
		const box = row.getBoundingClientRect();
		const dot = row.querySelector('[data-net-row-dot]')?.getBoundingClientRect();
		const title = row.querySelector('[data-net-row-title]')?.getBoundingClientRect();
		if (!dot || !title) {
			out.push(`${id}: missing dot or title`);
			continue;
		}
		if (dot.top < title.top - 1 || dot.bottom > title.bottom + 1) {
			out.push(`7 ${id}: dot ${Math.round(dot.top)}..${Math.round(dot.bottom)} outside title ${Math.round(title.top)}..${Math.round(title.bottom)}`);
		}
		if (title.width <= 0) out.push(`12 ${id}: title width ${title.width}`);
		const toggle = row.querySelector('[data-testid^="bond-toggle-"]');
		const bond = toggle?.parentElement;
		if (toggle && bond && visible(toggle)) {
			const x = Math.round(toggle.getBoundingClientRect().left - box.left);
			xs.push(x);
			switchX.push(`${id}=${x}`);
			const bondBox = bond.getBoundingClientRect();
			for (const el of row.querySelectorAll('*')) {
				if (bond.contains(el) || el.closest('button') || folded(el) || !visible(el)) continue;
				const text = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
				if (text && hit(el.getBoundingClientRect(), bondBox)) {
					out.push(`12 ${id}: switch over "${(el.textContent ?? '').trim().slice(0, 24)}"`);
				}
			}
		}
		const controls = [...row.querySelectorAll('button, [role="switch"]')]
			.filter((c) => visible(c) && !folded(c))
			.map((c) => c.getBoundingClientRect());
		controls.forEach((p, i) =>
			controls.slice(i + 1).forEach((q) => {
				if (hit(p, q)) out.push(`12 ${id}: two controls overlap`);
			}),
		);
	}
	if (xs.length > 0 && Math.max(...xs) - Math.min(...xs) > 1) {
		out.push(`8 switch x spread ${Math.max(...xs) - Math.min(...xs)}: ${switchX.join(' ')}`);
	}
	return out;
}

/** Check 13: nothing on the destination cuts text off, in any section. */
function truncatedText(): string[] {
	const out: string[] = [];
	for (const el of document.querySelectorAll<HTMLElement>('#main-content section *')) {
		const cs = getComputedStyle(el);
		// A 1px clip is a visually hidden copy (`sr-only`), not a cut-off name.
		if (cs.display === 'none' || cs.visibility === 'hidden' || el.clientWidth <= 1) continue;
		if (el.scrollWidth <= el.clientWidth + 1 || cs.overflowX === 'visible') continue;
		const full = (el.textContent ?? '').trim();
		if (full === '') continue;
		out.push(`13 "${full.slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
	}
	return out;
}

type TabStop = { top: number; bottom: number; left: number; right: number; name: string };

/** Tab through each row from its first control; a stop may never read before the one Tab left. */
async function backwardTabSteps(page: Page): Promise<{ steps: number; out: string[] }> {
	const out: string[] = [];
	let steps = 0;
	const rows = await page.locator('[data-net-row]').count();
	for (let index = 0; index < rows; index++) {
		const row = await page.evaluate((i) => {
			const el = document.querySelectorAll<HTMLElement>('[data-net-row]')[i];
			const first = el
				? [...el.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].find(
						(c) => !c.matches(':disabled') && c.getClientRects().length > 0,
					)
				: undefined;
			first?.focus();
			return first ? { id: el?.dataset.ifname ?? el?.dataset.device ?? '?', rtl: getComputedStyle(first).direction === 'rtl' } : null;
		}, index);
		if (!row) continue;
		let previous: TabStop | null = null;
		for (let n = 0; n < 12; n++) {
			const stop = await page.evaluate((i): TabStop | null => {
				const el = document.activeElement as HTMLElement | null;
				if (!el || !document.querySelectorAll('[data-net-row]')[i]?.contains(el)) return null;
				// Page coordinates: focusing a control scrolls it into view.
				const r = el.getBoundingClientRect();
				const [x, y] = [window.scrollX, window.scrollY];
				const name = el.dataset.testid ?? el.textContent?.trim().slice(0, 16) ?? '?';
				return { top: r.top + y, bottom: r.bottom + y, left: r.left + x, right: r.right + x, name };
			}, index);
			if (!stop) break;
			if (previous) {
				steps++;
				const above = stop.bottom <= previous.top + 1;
				const sameLine = !above && stop.top < previous.bottom - 1;
				const earlierInLine = row.rtl ? stop.left >= previous.right - 1 : stop.right <= previous.left + 1;
				if (above || (sameLine && earlierInLine)) {
					out.push(`${row.id}: ${previous.name} @${Math.round(previous.top)} -> ${stop.name} @${Math.round(stop.top)}`);
				}
			}
			previous = stop;
			await page.keyboard.press('Tab');
		}
	}
	return { steps, out };
}

/** From 36rem of row width (the row's own container query) the actions sit on the title line. */
function actionsOffTitleLine(): { wide: number; out: string[] } {
	let wide = 0;
	const out: string[] = [];
	for (const row of document.querySelectorAll<HTMLElement>('[data-net-row]')) {
		const sentinel = row.querySelector('[data-net-row-wide]');
		if (!sentinel || getComputedStyle(sentinel).display === 'none') continue;
		wide++;
		const actions = row.querySelector('[data-net-row-actions]')?.getBoundingClientRect();
		const title = row.querySelector('[data-net-row-title]')?.getBoundingClientRect();
		if (!actions || !title || actions.height === 0) continue;
		if (actions.top >= title.bottom || actions.bottom <= title.top) {
			out.push(`${row.dataset.ifname ?? row.dataset.device ?? '?'}: actions ${Math.round(actions.top)} off title ${Math.round(title.top)}..${Math.round(title.bottom)}`);
		}
	}
	return { wide, out };
}

/** Every switch thumb on the destination stays inside its track. */
function thumbsOutsideTracks(): { checked: number; out: string[] } {
	let checked = 0;
	const out: string[] = [];
	for (const track of document.querySelectorAll<HTMLElement>('#main-content [data-slot="switch"]')) {
		const thumb = track.querySelector('[data-slot="switch-thumb"]')?.getBoundingClientRect();
		const box = track.getBoundingClientRect();
		if (!thumb || box.width === 0) continue;
		if (track.getAttribute('aria-checked') === 'true') checked++;
		if (thumb.left < box.left - 0.5 || thumb.right > box.right + 0.5) {
			out.push(`${track.dataset.testid}: thumb ${Math.round(thumb.left)}..${Math.round(thumb.right)} outside ${Math.round(box.left)}..${Math.round(box.right)}`);
		}
	}
	return { checked, out };
}

/** Check 9: nothing leaves its card, and the page never scrolls sideways. */
function overflow(): string[] {
	const out: string[] = [];
	const se = document.scrollingElement as HTMLElement;
	if (se.scrollWidth > se.clientWidth) out.push(`9 document ${se.scrollWidth}>${se.clientWidth}`);
	const targets = document.querySelectorAll(
		'#main-content section button, #main-content section [role="switch"], [data-testid^="total-bandwidth-"]',
	);
	for (const el of targets) {
		const card = el.closest('section');
		const r = el.getBoundingClientRect();
		if (!card || r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
		const c = card.getBoundingClientRect();
		const cs = getComputedStyle(card);
		const left = c.left + Number.parseFloat(cs.borderLeftWidth);
		const right = c.right - Number.parseFloat(cs.borderRightWidth);
		if (r.left < left - 1 || r.right > right + 1) {
			const id = el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 20);
			out.push(`9 ${id} ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(left)}..${Math.round(right)}`);
		}
	}
	return out;
}

/** Check 10: WCAG contrast of each matching text against the colour painted behind it. */
function textContrast(selector: string): { text: string; ratio: number }[] {
	const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
	if (!canvas) return [];
	const rgba = (color: string): [number, number, number, number] => {
		canvas.clearRect(0, 0, 1, 1);
		canvas.fillStyle = '#000';
		canvas.fillStyle = color;
		canvas.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
		return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
	};
	const over = (top: number[], under: number[]) => top.slice(0, 3).map((c, i) => c * (top[3] ?? 1) + (under[i] ?? 0) * (1 - (top[3] ?? 1)));
	const background = (el: Element | null): number[] => {
		const layers: [number, number, number, number][] = [];
		for (let node = el; node; node = node.parentElement) {
			const layer = rgba(getComputedStyle(node).backgroundColor);
			if (layer[3] > 0) layers.push(layer);
			if (layer[3] >= 1) break;
		}
		return layers.reverse().reduce<number[]>((acc, layer) => over(layer, acc), [255, 255, 255]);
	};
	const luminance = (rgb: number[]) => {
		const [r, g, b] = rgb.map((v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
	};
	return [...document.querySelectorAll(selector)].map((el) => {
		const bg = background(el);
		const fg = over(rgba(getComputedStyle(el).color), bg);
		const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
		const ratio = Math.round((((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)) * 100) / 100;
		return { text: (el.textContent ?? '').trim().slice(0, 24), ratio };
	});
}

for (const locale of ['en', 'es', 'de']) {
	test(`one row anatomy at every width (${locale})`, async ({ authedPage: page }) => {
		await openNetwork(page, locale);
		const violations: string[] = [];
		for (const width of [320, 360, 390, 412, 1280]) {
			await atWidth(page, width);
			const geometry = await page.evaluate(rowGeometry);
			violations.push(
				...geometry
					.filter((v) => width !== 412 || v.startsWith('12'))
					.map((v) => `${locale}@${width} ${v}`),
			);
			if (width <= 360) {
				const cut = await page.evaluate(truncatedText);
				violations.push(...cut.map((v) => `${locale}@${width} ${v}`));
			}
			if (locale === 'de' && width <= 360) {
				violations.push(...(await page.evaluate(overflow)).map((v) => `${locale}@${width} ${v}`));
			}
		}
		expect(violations).toEqual([]);
	});
}

test('German totals and controls stay inside their cards with real throughput', async ({ authedPage: page }) => {
	await openNetwork(page, 'de', 98_765_432);
	await expect(page.getByTestId('total-bandwidth-up')).toContainText(/[1-9]/);
	const violations: string[] = [];
	for (const width of [320, 360]) {
		await atWidth(page, width);
		violations.push(...(await page.evaluate(overflow)).map((v) => `de@${width} ${v}`));
	}
	expect(violations).toEqual([]);
});

test('names stay whole across the destination at 320 and 390 px', async ({ authedPage: page }) => {
	const violations: string[] = [];
	for (const locale of ['en', 'de', 'ar', 'fr', 'pt-BR', 'ja']) {
		await openNetwork(page, locale);
		for (const width of [320, 390]) {
			await atWidth(page, width);
			violations.push(...(await page.evaluate(truncatedText)).map((v) => `${locale}@${width} ${v}`));
		}
	}
	expect(violations).toEqual([]);
});

test('Tab follows the reading order of every row, wide and on a phone', async ({ authedPage: page }) => {
	// Its three Tab walks took 22.4 to 29.9 s of the default 30 s on eight hosted runs, and a ninth timed out twice.
	test.setTimeout(60_000);
	const violations: string[] = [];
	let steps = 0;
	for (const [locale, width, height] of [
		['en', 1280, 800],
		['ar', 800, 480],
		['en', 390, 844],
	] as const) {
		await openNetwork(page, locale);
		await atWidth(page, width, height);
		if (width >= 800) {
			const placed = await page.evaluate(actionsOffTitleLine);
			if (placed.wide === 0) violations.push(`${locale}@${width} no row reports itself wide`);
			violations.push(...placed.out.map((v) => `${locale}@${width} ${v}`));
		}
		const result = await backwardTabSteps(page);
		steps += result.steps;
		violations.push(...result.out.map((v) => `${locale}@${width} ${v}`));
	}
	expect(steps).toBeGreaterThan(0);
	expect(violations).toEqual([]);
});

test('a checked switch keeps its thumb inside the track in Arabic', async ({ authedPage: page }) => {
	const violations: string[] = [];
	for (const theme of ['dark', 'light'] as const) {
		await setTheme(page, theme);
		await openNetwork(page, 'ar');
		await atWidth(page, 320);
		const { checked, out } = await page.evaluate(thumbsOutsideTracks);
		expect(checked, theme).toBeGreaterThan(0);
		violations.push(...out.map((v) => `${theme} ${v}`));
	}
	expect(violations).toEqual([]);
});

test('an active hotspot names its radio\'s mode hotspot', async ({ authedPage: page }) => {
	await openNetwork(page, 'en');
	await expect(page.getByTestId('hotspot-row').getByTestId('wifi-mode-badge')).toHaveAttribute('data-mode', 'hotspot');
});

test('reason notes are readable in dark mode at 360 px', async ({ authedPage: page }) => {
	await setTheme(page, 'dark');
	await openNetwork(page, 'en');
	await atWidth(page, 360);
	const ratios = await page.evaluate(textContrast, '[data-testid="modem-note"]');
	expect(ratios.length).toBeGreaterThan(0);
	expect(ratios.filter((r) => r.ratio < 4.5)).toEqual([]);
});

test('the collision bands are readable in both themes', async ({ authedPage: page }) => {
	const violations: string[] = [];
	for (const theme of ['light', 'dark'] as const) {
		await setTheme(page, theme);
		await openNetwork(page, 'en', 0, true);
		await expect(page.getByTestId('same-subnet-info')).toContainText(SHARED_SUBNET);
		await expect(page.getByTestId('bond-mapping-collision')).toBeVisible();
		await atWidth(page, 390);
		const ratios = await page.evaluate(
			textContrast,
			'[data-testid="same-subnet-info"] :is(p, code), [data-testid="bond-mapping-warning"] :is(p, code, span)',
		);
		expect(ratios.length, theme).toBeGreaterThan(4);
		violations.push(...ratios.filter((r) => r.ratio < 4.5).map((r) => `${theme} "${r.text}" ${r.ratio}`));
	}
	expect(violations).toEqual([]);
});

test('a focused row action keeps focus across the 36rem breakpoint', async ({ authedPage: page }) => {
	await openNetwork(page, 'en');
	const focused = () =>
		page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			return `${el?.closest<HTMLElement>('[data-net-row]')?.dataset.device ?? '-'} ${el?.dataset.testid ?? el?.tagName}`;
		});
	await atWidth(page, 1280);
	const connect = page.getByTestId('wifi-row').first().getByTestId('open-wifi-selector-dialog');
	const device = await page.getByTestId('wifi-row').first().getAttribute('data-device');
	await connect.focus();
	expect(await focused()).toBe(`${device} open-wifi-selector-dialog`);
	await atWidth(page, 390);
	expect(await focused()).toBe(`${device} open-wifi-selector-dialog`);
	await page.keyboard.press('Tab');
	expect(await focused()).toBe(`${device} open-wifi-mode`);
	await page.keyboard.press('Shift+Tab');
	await atWidth(page, 1280);
	expect(await focused()).toBe(`${device} open-wifi-selector-dialog`);
	await page.keyboard.press('Tab');
	expect(await focused()).toBe(`${device} open-wifi-mode`);
});

test('row controls meet the 44 px touch target on a phone', async ({ authedPage: page }) => {
	await openNetwork(page, 'en');
	await atWidth(page, 360);
	const buttons = await measureHitAreas(
		page,
		ROW_BUTTONS.map((id) => `[data-net-row] [data-testid="${id}"]`).join(', '),
	);
	const switches = await measureHitAreas(page, '[data-net-row] [role="switch"]');
	expect(buttons.length).toBeGreaterThan(0);
	expect(switches.length).toBeGreaterThan(0);
	// Whole CSS pixels: the switch overlay is `calc((100% - 44px) / 2)` per side, which resolves to 43.98px.
	expect(buttons.filter((b) => Math.round(b.boxHeight) < 44).map((b) => `${b.name} ${b.boxHeight}`)).toEqual([]);
	expect(switches.filter((s) => Math.round(s.hitHeight) < 44).map((s) => `${s.name} ${s.hitHeight}`)).toEqual([]);
});
