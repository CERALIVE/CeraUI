import { m } from "@ceraui/i18n/svelte";
import type { Modem, ModemList, WifiStatus } from "@ceraui/rpc/schemas";

const MAC_NAMED = /^(wl|en|ww)x[0-9a-f]{12}$/;
const INDEXED = /^(wlan|eth|wwan|usb)(\d+)$/;

/** Four hex digits are a display hint, not a unique adapter identifier. */
export function interfaceLabel(ifname: string): string {
	const mac = MAC_NAMED.exec(ifname);
	const indexed = mac ? null : INDEXED.exec(ifname);
	const family = mac?.[1] ?? indexed?.[1];
	const suffix = mac
		? ` (${ifname.slice(-4)})`
		: indexed
			? ` ${Number(indexed[2]) + 1}`
			: "";
	switch (family) {
		case "wl":
		case "wlan":
			return m["networking.types.wifi"]() + suffix;
		case "en":
		case "eth":
			return m["networking.types.ethernet"]() + suffix;
		case "ww":
		case "wwan":
			return m["networking.types.modem"]() + suffix;
		case "usb":
			return m["hud.linkName.usbTether"]({ iface: ifname });
		default:
			return ifname;
	}
}

function modemCarrier(modem: Modem): string | undefined {
	return (
		modem.status?.network?.trim() || modem.sim_network?.trim() || undefined
	);
}

function modemModel(modem: Modem): string {
	// Legacy descriptors carry “model - serial” in name, not in a separate field.
	const model = modem.model?.trim() || modem.name?.trim();
	return (
		model?.split(" - ", 1)[0]?.replace(/^(RM\d{3}[A-Z])-[A-Z]{2}$/i, "$1") ||
		modem.slot_label?.trim() ||
		m["networking.types.modem"]()
	);
}

interface InventoryName {
	readonly ifname: string;
	readonly base: string;
	readonly hint: string;
	readonly modem?: { readonly key: string; readonly wasTwin: boolean };
}

export interface LinkNames {
	readonly label: (ifname: string) => string;
	/** Visible correlation is needed even when the primary label has a port hint. */
	readonly correlation: (ifname: string) => string | undefined;
}

export interface LinkNameSources {
	readonly modems?: ModemList | undefined;
	readonly wifi?: WifiStatus | undefined;
}

const MAX_ABSENT_TWINS = 256;

/** Keep the displayed discriminator when a modem's collision group shrinks. */
export function createLinkNameProjection() {
	// null remembers the ifname *fallback*, not the old ifname after a rename.
	const knownTwins = new Map<string, string | null>();
	return ({ modems, wifi }: LinkNameSources): LinkNames => {
		const groups = new Map<string, InventoryName[]>();
		function add(row: InventoryName) {
			const group = groups.get(row.base);
			if (group) group.push(row);
			else groups.set(row.base, [row]);
		}

		for (const radio of Object.values(wifi ?? {})) {
			const { ifname } = radio;
			const ssid = radio.available?.find((network) => network.active)?.ssid;
			const type = m["networking.types.wifi"]();
			const idleLabel = interfaceLabel(ifname);
			const hint = /^wlx[0-9a-f]{12}$/.test(ifname)
				? ifname.slice(-4)
				: /^wlan\d+$/.test(ifname)
					? String(Number(ifname.slice(4)) + 1)
					: ifname;
			add({
				ifname,
				base: ssid
					? m["hud.linkName.wifiNetwork"]({ network: ssid })
					: idleLabel === ifname
						? `${type} (${ifname})`
						: idleLabel,
				hint: ssid ? hint : ifname,
			});
		}

		for (const modem of Object.values(modems ?? {})) {
			const { ifname } = modem;
			if (!ifname) continue;
			const model = modemModel(modem);
			const carrier = modem.no_sim ? undefined : modemCarrier(modem);
			const base = carrier ? `${carrier} · ${model}` : model;
			const anchor = modem.stable_key;
			const key = JSON.stringify([
				base,
				anchor === undefined ? "iface" : "port",
				anchor ?? ifname,
			]);
			const remembered = knownTwins.get(key);
			add({
				ifname,
				base,
				hint:
					remembered === null
						? ifname
						: (remembered ?? (modem.port_label?.trim() || ifname)),
				modem: { key, wasTwin: remembered !== undefined },
			});
		}

		const labels = new Map<string, string>();
		const correlation = new Set<string>();
		const presentTwins = new Set<string>();
		for (const [base, group] of groups) {
			const hints = new Map<string, number>();
			for (const { hint } of group) hints.set(hint, (hints.get(hint) ?? 0) + 1);
			for (const row of group) {
				const { modem, hint, ifname } = row;
				const qualified = group.length > 1 || modem?.wasTwin === true;
				const distinctHint = hints.get(hint) === 1 ? hint : ifname;
				if (modem && qualified) {
					// Refresh even a lone survivor, to preserve recency after it leaves.
					knownTwins.delete(modem.key);
					knownTwins.set(
						modem.key,
						distinctHint === ifname ? null : distinctHint,
					);
					presentTwins.add(modem.key);
				}
				labels.set(
					ifname,
					!qualified
						? base
						: modem
							? `${base} · ${distinctHint}`
							: `${base} (${distinctHint})`,
				);
				if (qualified) correlation.add(ifname);
			}
		}
		let absentTwins = knownTwins.size - presentTwins.size;
		for (const key of knownTwins.keys()) {
			if (absentTwins <= MAX_ABSENT_TWINS) break;
			if (presentTwins.has(key)) continue;
			knownTwins.delete(key);
			absentTwins--;
		}
		return {
			label: (ifname) => labels.get(ifname) ?? interfaceLabel(ifname),
			correlation: (ifname) => (correlation.has(ifname) ? ifname : undefined),
		};
	};
}
