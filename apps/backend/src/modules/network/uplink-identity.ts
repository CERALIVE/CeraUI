/**
 * WHAT an uplink IS, resolved from the ONE classification the `netif`
 * projection already uses.
 *
 * BOARD-PROVEN MISMATCH this closes: `eth1` is a Huawei E3372 LTE dongle
 * (cdc_ether, 12d1:14dc). The `netif` projection classifies it correctly as
 * `router_cellular` — it reads USB descriptors — while the uplink-health engine
 * derived its own kind from the interface NAME and reported `ethernet`. Its
 * identical twin, which won the udev rename race and is called
 * `enx0c5b8f279a64`, matched the `enx` arm and reported `cellular`. One SKU on
 * one hub, one port apart, typed two different ways by a rule that never looked
 * at the hardware.
 *
 * So the markers are consulted FIRST and are authoritative. The name ladder
 * below them is a FALLBACK for devices the USB sweep cannot describe at all —
 * a PCIe/MHI modem, a PPP link — never a second opinion about a device it can.
 */

import { routerCellularDisplayName } from "../modems/physical-identity.ts";
import {
	getModemNetMarker,
	getRouterCellularMarker,
} from "./router-cellular-scan.ts";
import type { UplinkKind } from "./uplink-health/model.ts";

export interface UplinkIdentity {
	readonly kind: UplinkKind;
	/** Absent whenever this host could not name the device. Never invented. */
	readonly displayName?: string;
}

/**
 * Kernel-reserved WWAN and PPP names, which describe a device class rather than
 * guessing at one: only a cellular data function is called `ww*`, and `ppp*` is
 * a dial-up link by definition. `usb*` is the classic RNDIS tether name.
 *
 * `enx*` is DELIBERATELY ABSENT. It is systemd's predictable name for ANY USB
 * network adapter, cellular or not, so reading it as cellular is exactly the
 * coin-flip that typed one HiLink twin differently from the other.
 */
const CELLULAR_NAME_FALLBACK = /^(?:ww|ppp|usb)/;

function nameFallbackKind(iface: string): UplinkKind {
	if (iface.startsWith("wl")) return "wifi";
	if (CELLULAR_NAME_FALLBACK.test(iface)) return "cellular";
	if (/^(?:eth|en)/.test(iface)) return "ethernet";
	return "other";
}

/**
 * A marker's operator-facing name, through the SAME rule that titles the
 * device's modem row (`routerCellularDisplayName`) so the two surfaces can
 * never disagree about what one device is called.
 *
 * The dongle's own admin API is not consulted here: this runs on the 5 s
 * health cadence, the admin cache is keyed to a different poll, and a name that
 * changed depending on which poll last landed would be worse than the
 * descriptor answer that is always available.
 */
function markerDisplayName(
	vendor: string,
	model: string,
	serial?: string,
): string | undefined {
	const name = routerCellularDisplayName(vendor, model, undefined, serial);
	return name.trim() === "" ? undefined : name;
}

export function resolveUplinkIdentity(iface: string): UplinkIdentity {
	const router = getRouterCellularMarker(iface);
	if (router !== undefined) {
		const displayName = markerDisplayName(
			router.vendor,
			router.model,
			router.serial,
		);
		return {
			kind: "cellular",
			...(displayName !== undefined ? { displayName } : {}),
		};
	}

	const modemNet = getModemNetMarker(iface);
	if (modemNet !== undefined) {
		const displayName = markerDisplayName(modemNet.vendor, modemNet.model);
		return {
			kind: "cellular",
			...(displayName !== undefined ? { displayName } : {}),
		};
	}

	return { kind: nameFallbackKind(iface) };
}
