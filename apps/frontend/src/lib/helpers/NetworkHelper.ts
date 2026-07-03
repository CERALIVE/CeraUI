import { getLL } from "@ceraui/i18n/svelte";
import type {
	NetifMessage,
	SimPukUnlockOutput,
	SimUnlockOutput,
	StatusMessage,
	WifiBand,
	WifiSecurity,
} from "@ceraui/rpc/schemas";
import QRCode from "qrcode";

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
		name = getLL().networking.types.wifi();
	} else if (name.startsWith("eth") || name.startsWith("en")) {
		name = getLL().networking.types.ethernet();
	} else if (name.startsWith("ww")) {
		name = getLL().networking.types.modem();
	} else if (name.startsWith("usb")) {
		name = getLL().networking.types.usb();
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

export const renameSupportedModemNetwork = (item: string): string => {
	// Extract individual components like "3g2g" -> ["3G", "2G"]
	return item
		.replace(/(\d+g)/gi, (match) => match.toUpperCase())
		.split(/(?<=G)(?=\d)/)
		.join(" / ");
};

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
		return getLL().wifiBands.band_6ghz();
	} else if (freq > 5000) {
		return getLL().wifiBands.band_5ghz();
	}
	return getLL().wifiBands.band_2_4ghz();
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
	wifiNetwork: ValueOf<StatusMessage["wifi"]>["available"][number],
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

export async function generateWifiQr(
	ssid: string,
	password: string,
	encryption: WifiSecurity = "WPA",
): Promise<string> {
	if (!ssid) throw new Error("SSID is required");

	const qrData = `WIFI:T:${encryption};S:${ssid};P:${password};;`;

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
