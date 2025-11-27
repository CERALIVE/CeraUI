import { getLL } from "@ceraui/i18n/svelte";
import QRCode from "qrcode";
import { toast } from "svelte-sonner";

import {
	getStatus,
	sendMessage,
	socket,
} from "$lib/stores/websocket-store.svelte";
import type { ValueOf } from "$lib/types";
import type {
	NetifMessage,
	StatusMessage,
	WifiSecurity,
} from "$lib/types/socket-messages";

export type WifiBandNames = "auto" | "auto_50" | "auto_24";

export const convertBytesToKbids = (bytes: number) => {
	return Math.round((bytes * 8) / 1024);
};

export const setNetif = (
	name: string,
	ip: string | undefined,
	enabled: boolean,
) => {
	sendMessage(JSON.stringify({ netif: { name, ip, enabled } }));
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
	return `${modem?.status.network} (${modem?.status.network_type})`;
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

export const turnHotspotModeOn = (deviceId: number) => {
	socket.send(
		JSON.stringify({ wifi: { hotspot: { start: { device: `${deviceId}` } } } }),
	);
};

export const turnHotspotModeOff = (deviceId: number) => {
	socket.send(
		JSON.stringify({ wifi: { hotspot: { stop: { device: `${deviceId}` } } } }),
	);
};

export const changeHotspotSettings = ({
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
	socket.send(
		JSON.stringify({
			wifi: {
				hotspot: { config: { device: `${deviceId}`, name, password, channel } },
			},
		}),
	);
};
export const changeModemSettings = ({
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
	socket.send(
		JSON.stringify({
			modems: {
				config: {
					network_type,
					roaming: roaming ?? false,
					network: `${network ?? ""}`,
					autoconfig: autoconfig ?? false,
					apn,
					username,
					password,
					device: `${device}`,
				},
			},
		}),
	);
};

export const scanModemNetworks = (deviceId: number) => {
	socket.send(JSON.stringify({ modems: { scan: { device: deviceId } } }));
};

export const scanWifi = (deviceId: number | string, notification = true) => {
	if (notification) {
		toast.info(getLL().networkHelper.toast.scanningWifi(), {
			description: getLL().networkHelper.toast.scanningWifiDescription(),
			duration: 5000,
		});
	}
	socket.send(JSON.stringify({ wifi: { scan: `${deviceId}` } }));
};

export const disconnectWifi = (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.warning(getLL().networkHelper.toast.disconnectingWifi(), {
		description: getLL().networkHelper.toast.disconnectingWifiDescription({
			ssid: wifi.ssid,
		}),
	});
	socket.send(
		JSON.stringify({
			wifi: {
				disconnect: uuid,
			},
		}),
	);
};

export const connectWifi = (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.info(getLL().networkHelper.toast.connectingWifi(), {
		description: getLL().networkHelper.toast.connectingWifiDescription({
			ssid: wifi.ssid,
		}),
		duration: 12000,
	});
	socket.send(
		JSON.stringify({
			wifi: {
				connect: uuid,
			},
		}),
	);
};

export const connectToNewWifi = (
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
	socket.send(
		JSON.stringify({
			wifi: {
				new: {
					device: `${deviceId}`,
					ssid: `${ssid}`,
					password: `${password}`,
				},
			},
		}),
	);
};

export const forgetWifi = (
	uuid: string,
	wifi: ValueOf<StatusMessage["wifi"]>["available"][number],
) => {
	toast.info(getLL().networkHelper.toast.wifiNetworkForgotten(), {
		description: getLL().networkHelper.toast.wifiNetworkForgottenDescription({
			ssid: wifi.ssid,
		}),
	});

	socket.send(
		JSON.stringify({
			wifi: {
				forget: uuid,
			},
		}),
	);
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
