import { getLL } from "@ceraui/i18n/svelte";
import type {
	NetifMessage,
	StatusMessage,
	WifiBand,
	WifiSecurity,
} from "@ceraui/rpc/schemas";
import QRCode from "qrcode";
import { toast } from "svelte-sonner";

import { rpc } from "$lib/rpc/client";
import { getStatus } from "$lib/stores/websocket-store.svelte";
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

export const turnHotspotModeOn = async (deviceId: number) => {
	try {
		await rpc.wifi.hotspotStart({ device: String(deviceId) });
	} catch (error) {
		console.error("Failed to start hotspot:", error);
		throw error;
	}
};

export const turnHotspotModeOff = async (deviceId: number) => {
	try {
		await rpc.wifi.hotspotStop({ device: String(deviceId) });
	} catch (error) {
		console.error("Failed to stop hotspot:", error);
		throw error;
	}
};

export const changeHotspotSettings = async ({
	deviceId,
	name,
	password,
	channel,
}: {
	deviceId: string | number;
	name: string;
	password: string;
	channel: string;
}) => {
	try {
		await rpc.wifi.hotspotConfigure({
			device: String(deviceId),
			name,
			password,
			channel,
		});
	} catch (error) {
		console.error("Failed to configure hotspot:", error);
		throw error;
	}
};
export const changeModemSettings = async ({
	network_type,
	roaming,
	network,
	autoconfig,
	apn,
	username,
	password,
	device,
}: {
	network_type: string;
	roaming?: boolean;
	network?: string;
	autoconfig?: boolean;
	apn: string;
	username: string;
	password: string;
	device: number | string;
}) => {
	try {
		await rpc.modems.configure({
			device: String(device),
			network_type,
			roaming: roaming ?? false,
			network: network ?? "",
			autoconfig: autoconfig ?? false,
			apn,
			username,
			password,
		});
	} catch (error) {
		console.error("Failed to configure modem:", error);
		throw error;
	}
};

export const scanModemNetworks = async (deviceId: number) => {
	try {
		await rpc.modems.scan({ device: deviceId });
	} catch (error) {
		console.error("Failed to scan modem networks:", error);
		throw error;
	}
};

export const scanWifi = async (
	deviceId: number | string,
	notification = true,
) => {
	if (notification) {
		toast.info(getLL().networkHelper.toast.scanningWifi(), {
			description: getLL().networkHelper.toast.scanningWifiDescription(),
			duration: 5000,
		});
	}
	try {
		await rpc.wifi.scan({ device: String(deviceId) });
	} catch (error) {
		console.error("Failed to scan WiFi:", error);
		throw error;
	}
};

export const disconnectWifi = async (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.warning(getLL().networkHelper.toast.disconnectingWifi(), {
		description: getLL().networkHelper.toast.disconnectingWifiDescription({
			ssid: wifi.ssid,
		}),
	});
	try {
		await rpc.wifi.disconnect({ uuid });
	} catch (error) {
		console.error("Failed to disconnect WiFi:", error);
		throw error;
	}
};

export const connectWifi = async (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.info(getLL().networkHelper.toast.connectingWifi(), {
		description: getLL().networkHelper.toast.connectingWifiDescription({
			ssid: wifi.ssid,
		}),
		duration: 12000,
	});
	try {
		await rpc.wifi.connect({ uuid });
	} catch (error) {
		console.error("Failed to connect WiFi:", error);
		throw error;
	}
};

export const connectToNewWifi = async (
	deviceId: string | number,
	ssid: string,
	password: string,
) => {
	toast.info(getLL().networkHelper.toast.connectingNewWifi(), {
		description: getLL().networkHelper.toast.connectingNewWifiDescription({
			ssid,
		}),
		duration: 15000,
	});
	try {
		await rpc.wifi.connectNew({
			device: String(deviceId),
			ssid,
			password,
		});
	} catch (error) {
		console.error("Failed to connect to new WiFi:", error);
		throw error;
	}
};

export const forgetWifi = async (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.info(getLL().networkHelper.toast.wifiNetworkForgotten(), {
		description: getLL().networkHelper.toast.wifiNetworkForgottenDescription({
			ssid: wifi.ssid,
		}),
	});
	try {
		await rpc.wifi.forget({ uuid });
	} catch (error) {
		console.error("Failed to forget WiFi network:", error);
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
