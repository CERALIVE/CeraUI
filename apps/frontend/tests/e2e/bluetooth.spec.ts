import { expect, test } from './fixtures/index.js';
import {
	BT_MIC_BATTERY,
	type BluetoothWire,
	btMicPairedStatus,
	installBluetoothWire,
} from './helpers/bluetooth-wire.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * The Bluetooth card's happy flow, in a real browser, on the `bt-mic-paired`
 * roster.
 *
 * The worker really is booted on that scenario — but its roster does NOT reach
 * the wire today: todo 14's mock provider is orphaned (`bluetooth-runtime.ts`
 * builds its payload from the real `BluetoothStack`, which on a dev host is
 * honestly unavailable), and wiring that seam belongs to todo 12/13's files.
 * So the payload is injected over the page socket instead, exactly as
 * `modem-ux.visual.spec.ts` injects its roster — see `helpers/bluetooth-wire.ts`
 * for the full reasoning and for what this does and does not prove.
 *
 * `backendScenario` is worker-scoped, so it MUST sit at file top level and this
 * file hosts exactly one scenario (PLAYBOOK.md). It is kept rather than dropped
 * so that the day the device seam lands, deleting the injection is the only
 * change this spec needs.
 */
test.use({ backendScenario: 'bt-mic-paired' });

const CARD = '[data-testid="bluetooth-section"]';

test.describe('Bluetooth card — bt-mic-paired', () => {
	let wire: BluetoothWire;

	test.beforeEach(async ({ page }) => {
		wire = await installBluetoothWire(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		await wire.publish();
		await expect(page.locator(CARD)).toBeVisible();
	});

	test('renders the bonded microphone with its adapter state, chips and battery', async ({
		page,
	}) => {
		// The operator's persisted preference is ON, so the switch reads checked
		// and the adapter reports itself powered rather than merely present.
		await expect(page.getByTestId('bluetooth-enable')).toHaveAttribute(
			'aria-checked',
			'true',
		);
		await expect(page.getByTestId('bluetooth-adapter')).toHaveAttribute(
			'data-powered',
			'true',
		);
		await expect(page.getByTestId('bluetooth-adapter')).toHaveAttribute(
			'data-discovering',
			'false',
		);

		await expect(page.getByTestId('bluetooth-device-name')).toHaveText(
			'Jabra Talk 65',
		);
		// audio-input, so the microphone glyph — not the generic Bluetooth one.
		await expect(
			page.getByTestId('bluetooth-device-icon-audio-input'),
		).toBeVisible();
		await expect(page.getByTestId('bluetooth-chip-paired')).toBeVisible();
		await expect(page.getByTestId('bluetooth-chip-trusted')).toBeVisible();
		await expect(page.getByTestId('bluetooth-chip-connected')).toBeVisible();
		await expect(page.getByTestId('bluetooth-chip-battery')).toContainText(
			String(BT_MIC_BATTERY),
		);

		// A bonded row offers the bonded verbs and never Pair.
		await expect(page.getByTestId('bluetooth-action-disconnect')).toBeVisible();
		await expect(page.getByTestId('bluetooth-action-untrust')).toBeVisible();
		await expect(page.getByTestId('bluetooth-action-forget')).toBeVisible();
		await expect(page.getByTestId('bluetooth-action-pair')).toHaveCount(0);

		// A connected microphone points at the Live source list. Todo 16 wires the
		// actual audio-source selection; this is the pointer, not the wiring.
		await expect(page.getByTestId('bluetooth-audio-source-hint')).toBeVisible();
		await expect(page.getByTestId('bluetooth-audio-source-link')).toBeVisible();
	});

	test('a disconnect/connect round trip moves the chips, the battery and the hint', async ({
		page,
	}) => {
		// BlueZ retracts the whole `Battery1` interface on disconnect and the
		// reconnect restores the seeded level, so both halves are asserted — a
		// component that cached the reading would fail the first one.
		await page.getByTestId('bluetooth-action-disconnect').click();

		await expect(page.getByTestId('bluetooth-chip-connected')).toHaveCount(0);
		await expect(page.getByTestId('bluetooth-chip-battery')).toHaveCount(0);
		await expect(page.getByTestId('bluetooth-audio-source-hint')).toHaveCount(0);
		// Still bonded, so the row keeps its trust flag and offers Connect.
		await expect(page.getByTestId('bluetooth-chip-paired')).toBeVisible();
		await expect(page.getByTestId('bluetooth-action-connect')).toBeVisible();

		await page.getByTestId('bluetooth-action-connect').click();

		await expect(page.getByTestId('bluetooth-chip-connected')).toBeVisible();
		await expect(page.getByTestId('bluetooth-chip-battery')).toContainText(
			String(BT_MIC_BATTERY),
		);
		await expect(page.getByTestId('bluetooth-audio-source-hint')).toBeVisible();
	});

	test('the master toggle only moves once the device confirms it', async ({
		page,
	}) => {
		const toggle = page.getByTestId('bluetooth-enable');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');

		await toggle.click();

		// Pessimistic: the switch lands on `false` only because the confirming
		// `bluetooth` broadcast said so, and the card then reports the OFF state
		// rather than a service fault — the stack records an operator-disabled
		// radio as `bluez_unavailable`, which is not the operator's answer.
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(page.getByTestId('bluetooth-off')).toBeVisible();
		await expect(page.getByTestId('bluetooth-unavailable')).toHaveCount(0);
		await expect(page.getByTestId('bluetooth-scan')).toHaveCount(0);

		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('bluetooth-device-name')).toHaveText(
			'Jabra Talk 65',
		);
	});

	test('a typed refusal renders inline on the row, never as a toast', async ({
		page,
	}) => {
		// `pairing_agent_unavailable` is what a real board answers today (no
		// `org.bluez.Agent1` exporter ships), so it is the refusal most worth
		// proving reads as "start it from the other device".
		await wire.set({
			...btMicPairedStatus(),
			devices: [
				{
					path: '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_22',
					adapterPath: '/org/bluez/hci0',
					address: 'AA:BB:CC:DD:EE:22',
					name: 'Pixel 8 Pro',
					deviceClass: 'audio-input',
					transport: 'bredr',
					paired: false,
					trusted: false,
					connected: false,
					blocked: false,
					scoCapable: false,
					rssi: -63,
				},
			],
		});
		await expect(page.getByTestId('bluetooth-action-pair')).toBeVisible();

		wire.refuseNext('pairing_agent_unavailable');
		await page.getByTestId('bluetooth-action-pair').click();

		const band = page.getByTestId('bluetooth-device-refused');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('role', 'status');
		// The machine token never reaches the operator, and no toast fires.
		await expect(band).not.toContainText('pairing_agent_unavailable');
		await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
	});

	test('no operator-facing string in the card is a raw i18n key or a wire token', async ({
		page,
	}) => {
		// `resolveMessageKey` renders an unknown key as the key itself, and the
		// refusal/cause vocabularies are machine tokens. Both would be invisible
		// to a per-string assertion, so the whole card's text is swept.
		const text = (await page.locator(CARD).innerText()).trim();
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toMatch(/network\.bluetooth\./);
		expect(text).not.toMatch(
			/\b(bluez_unavailable|bus_unreachable|no_adapter|unit_missing|adapter_busy|pairing_agent_unavailable|audio-input)\b/,
		);
	});
});
