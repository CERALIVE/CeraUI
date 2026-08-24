import { m } from "@ceraui/i18n/svelte";
import type {
	HotspotSecurityId,
	NetifMessage,
	SimPukUnlockOutput,
	SimUnlockOutput,
	StatusMessage,
	WifiBand,
} from "@ceraui/rpc/schemas";
import QRCode from "qrcode";

import { formatGenerationRun } from "$lib/modem/operator-labels";
import { rpc } from "$lib/rpc/client";
import { getStatus } from "$lib/rpc/subscriptions.svelte";
import type { ValueOf } from "$lib/types";

// Re-export type
export type { WifiBand };

export const convertBytesToKbids = (bytes: number) => {
	return Math.round((bytes * 8) / 1024);
};

export const setNetif = async (
	name: string,
	ip: string | undefined,
	enabled: boolean,
) => {
	try {
		await rpc.network.configure({ name, ip, enabled });
	} catch (error) {
		console.error("Failed to configure network interface:", error);
		throw error;
	}
};

export const networkRenameWithError = (name: string, error?: string) => {
	name = networkRename(name);
	if (error) {
		name += ` (${error})`;
	}
	return name;
};

export const networkRename = (name: string) => {
	let numberSuffix = "";
	const number = name.match(/\d+$/g)?.[0];
	if (number) {
		numberSuffix = ` ${Number.parseInt(number, 10) + 1}`;
		name = name.slice(0, -number.length).trim();
	}

	if (name.startsWith("wl")) {
		name = m["networking.types.wifi"]();
	} else if (name.startsWith("eth") || name.startsWith("en")) {
		name = m["networking.types.ethernet"]();
	} else if (name.startsWith("ww")) {
		name = m["networking.types.modem"]();
	} else if (name.startsWith("usb")) {
		name = m["networking.types.usb"]();
	}

	return name + numberSuffix;
};

export const getModemNetworkName = (name: string) => {
	const status = getStatus();
	if (!status?.modems) return "";
	const modem = Object.values(status.modems).find(
		(modem) => modem.ifname === name,
	);
	if (!modem?.status) return "";
	return `${modem.status.network} (${modem.status.network_type})`;
};

export const renameSupportedModemNetwork = (item: string): string =>
	formatGenerationRun(item);

export const getAvailableNetworks = (message?: NetifMessage) => {
	if (message) {
		return Object.values(message).filter((network) => !network.error);
	}
	return [];
};

export const getUsedNetworks = (message?: NetifMessage) => {
	if (message) {
		return Object.values(message).filter(
			(network) => !network.error && network.enabled,
		);
	}
	return [];
};

export const getTotalBandwidth = (message?: NetifMessage) => {
	if (message) {
		let bandwith = 0;
		Object.values(message).forEach((network) => {
			bandwith += convertBytesToKbids(network?.tp ?? 0);
		});

		return bandwith;
	} else return 0;
};

export const getWifiStatus = (
	wifiNetWork: StatusMessage["wifi"][keyof StatusMessage["wifi"]],
) => {
	if (wifiNetWork.hotspot) {
		return "hotspot";
	}
	if (wifiNetWork.conn) {
		return "connected";
	}
	return "disconnected";
};

export const getConnection = (
	wifiNetwork: StatusMessage["wifi"][keyof StatusMessage["wifi"]],
) => {
	if (wifiNetwork.conn && wifiNetwork.available) {
		return wifiNetwork.available.filter((available) => available.active)[0];
	} else return undefined;
};

export const getWifiBand = (freq: number) => {
	if (freq > 6000) {
		return m["wifiBands.band_6ghz"]();
	} else if (freq > 5000) {
		return m["wifiBands.band_5ghz"]();
	}
	return m["wifiBands.band_2_4ghz"]();
};

export const unlockSimPin = async (
	modemPath: string,
	pin: string,
): Promise<SimUnlockOutput> => {
	try {
		return await rpc.modems.unlockSim({ modemPath, pin });
	} catch (error) {
		console.error("Failed to unlock SIM:", error);
		throw error;
	}
};

export const unlockSimPuk = async (
	modemPath: string,
	puk: string,
	newPin: string,
): Promise<SimPukUnlockOutput> => {
	try {
		return await rpc.modems.unlockSimPuk({ modemPath, puk, newPin });
	} catch (error) {
		console.error("Failed to unlock SIM with PUK:", error);
		throw error;
	}
};

export const getWifiUUID = (
	wifiNetwork: NonNullable<ValueOf<StatusMessage["wifi"]>["available"]>[number],
	saved: ValueOf<StatusMessage["wifi"]>["saved"],
) => {
	const found = Object.keys(saved).find((value) => {
		return wifiNetwork.ssid === value;
	});
	if (found) {
		return saved[found];
	}
	return undefined;
};

// The WIFI-QR format (ZXing, and the phone cameras that follow it) reads `\ ; , :`
// as field structure, so an unescaped one inside a credential moves the field
// boundary and the scanner joins the wrong network. ONE pass over the character
// class is load-bearing: escaping the four in sequence re-escapes the backslashes
// the earlier steps just inserted.
function escapeWifiQrField(value: string): string {
	return value.replace(/[\\;,:]/g, "\\$&");
}

/**
 * The `T:` token of a WIFI-QR payload, and it is a CLOSED set on purpose.
 *
 * It is deliberately NOT `WifiSecurity`, which is the free-form nmcli SECURITY
 * string (`"WPA2"`, `"WPA1 WPA2 802.1X"`, `""` for open) a scan row carries.
 * That string is a DESCRIPTION of somebody else's network; this is an
 * INSTRUCTION to a phone's camera, and the two vocabularies do not overlap — a
 * scanner handed `WPA1 WPA2 802.1X` here reads an unknown auth type and refuses
 * the join. Narrowing the parameter is what makes an unhandled security mode a
 * compile error rather than an unjoinable QR.
 */
export type WifiQrSecurity = "WPA" | "SAE" | "WEP" | "nopass";

/**
 * The QR token for a hotspot's configured security mode.
 *
 * A WPA3-SAE access point advertised as `T:WPA` produces a QR that SCANS
 * PERFECTLY and then fails to join — the phone offers a PSK handshake the AP
 * will not accept — so the operator sees a working code and a device that will
 * not connect, with nothing on screen linking the two. An unset mode is WPA2
 * (`DEFAULT_HOTSPOT_SECURITY`), which is the token every hotspot emitted before
 * the mode became selectable.
 */
export function hotspotQrSecurity(
	security: HotspotSecurityId | undefined,
): WifiQrSecurity {
	return security === "wpa3-sae" ? "SAE" : "WPA";
}

export async function generateWifiQr(
	ssid: string,
	password: string,
	encryption: WifiQrSecurity = "WPA",
): Promise<string> {
	if (!ssid) throw new Error("SSID is required");

	const qrData = `WIFI:T:${encryption};S:${escapeWifiQrField(ssid)};P:${escapeWifiQrField(password)};;`;

	return QRCode.toDataURL(qrData, {
		errorCorrectionLevel: "H",
		width: 256,
	});
}

export async function generateDeviceAccessQr(url: string): Promise<string> {
	if (!url) throw new Error("Device URL is required");

	return QRCode.toDataURL(url, {
		errorCorrectionLevel: "H",
		width: 256,
	});
}
