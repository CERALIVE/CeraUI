import type { WifiStatus } from '@ceraui/rpc/schemas';
import { expect, test } from './fixtures/index.js';
import { NetworkPage } from './pages/network.js';

for (const change of ['status patch', 'incarnation rotation'] as const) {
	test(`hotspot draft binding survives ${change} with the right consent`, async ({
		pageRpc,
		authedPage: page,
	}) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();
		await network.openHotspotGate();
		const dialog = page.getByRole('dialog', { name: 'Configure Hotspot' });
		const gate = dialog.getByTestId('hotspot-activation-confirm');
		const device = await gate.getAttribute('data-device');
		if (!device) throw new Error('The real gate did not identify its device');
		const wifi = await pageRpc.call<WifiStatus>(['wifi', 'getStatus']);
		const radio = wifi[device];
		expect(typeof radio?.incarnation).toBe('string');
		const name = gate.getByTestId('hotspot-confirm-name');
		const password = gate.getByTestId('hotspot-confirm-password');
		const storedName = await name.inputValue();
		const storedPassword = await password.inputValue();
		await name.fill('CeraLive-DraftBinding');
		await password.fill('draft-binding-419');
		await gate.getByRole('checkbox').click();
		await expect(gate.getByRole('checkbox')).toBeChecked();

		if (change === 'status patch') {
			await pageRpc.call(['dev', 'emit'], {
				type: 'status',
				payload: {
					wifi: { ...wifi, [device]: { ...radio, ifname: 'same-lifetime-patch' } },
				},
			});
			// Receipt barrier on the real owner, before asserting the retained draft.
			await expect(dialog.getByText('same-lifetime-patch', { exact: true })).toBeVisible();
			await expect(name).toHaveValue('CeraLive-DraftBinding');
			await expect(password).toHaveValue('draft-binding-419');
			await expect(gate.getByRole('checkbox')).toBeChecked();
			await gate.getByTestId('hotspot-confirm-activate').click();
			await expect.poll(async () => {
				const current = await pageRpc.call<WifiStatus>(['wifi', 'getStatus']);
				return current[device]?.hotspot?.name;
			}).toBe('CeraLive-DraftBinding');
			const active = await pageRpc.call<WifiStatus>(['wifi', 'getStatus']);
			expect(active[device]?.hotspot?.password).toBe('draft-binding-419');
			// The mock's periodic feedback is signal-driven. Hydrate from its
			// actual active state rather than waiting for an unrelated signal tick.
			await pageRpc.call(['dev', 'emit'], { type: 'status', payload: { wifi: active } });
			await expect(dialog.locator('#hotspot-password')).toBeVisible();
		} else {
			await pageRpc.call(['dev', 'rebindWifi'], { device });
			await expect(name).toHaveValue(storedName);
			await expect(password).toHaveValue(storedPassword);
			await expect(gate.getByRole('checkbox')).not.toBeChecked();
			await expect(gate.getByTestId('hotspot-confirm-activate')).toBeDisabled();
			await expect(gate.getByTestId('hotspot-confirm-radio-changed')).toBeVisible();
		}
	});
}
