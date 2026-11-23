import { z } from 'zod';
import { normalizeMacAddress } from '../capabilities/mac-address';
import { wifiStationAllowsBlankPassword } from '../capabilities/wifi-station-security';

export const WIFI_PASSWORD_MIN = 8;

// Raw nmcli SECURITY tokens, including the empty string for open networks.
export const wifiSecuritySchema = z.string();
export type WifiSecurity = z.infer<typeof wifiSecuritySchema>;

export const wifiNewInputSchema = z
	.object({
		device: z.string(),
		ssid: z.string().min(1, 'SSID cannot be empty'),
		password: z.string(),
		security: wifiSecuritySchema.optional(),
		// Omission is valid on the wire. The station handler refuses to guess.
		bssid: z
			.string()
			.refine((bssid) => normalizeMacAddress(bssid) !== undefined, 'Invalid BSSID')
			.optional(),
	})
	.refine(
		({ password, security }) =>
			password.length >= WIFI_PASSWORD_MIN ||
			(password === '' && wifiStationAllowsBlankPassword(security)),
		{ path: ['password'], message: 'Password must be at least 8 characters' },
	);
export type WifiNewInput = z.infer<typeof wifiNewInputSchema>;
