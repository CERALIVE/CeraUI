import { beforeEach, describe, expect, test } from "bun:test";

import {
	getNetworkInterfaces,
	netIfBuildMsg,
	processIfconfigOutput,
	setNetifDupIpSuppression,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";

// Minimal `ifconfig` stanza the existing parser understands (RUNNING flag +
// inet + netmask + the `TX packets N  bytes N` shape with its mandatory double
// space). `name` is deliberately NOT a `wlan*` name so the parser's WiFi
// device-list side-effect (a 1s wifiUpdateDevices timer) never fires in tests.
function ifconfigStanza(
	name: string,
	ip: string,
	netmask = "255.255.255.0",
	txBytes = 1000,
): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask ${netmask}  broadcast 192.168.0.255`,
		"        ether aa:bb:cc:dd:ee:ff  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		`        TX packets 100  bytes ${txBytes} (1.0 KB)`,
	].join("\n");
}

function ifconfig(...stanzas: string[]): string {
	return stanzas.join("\n\n");
}

function resetState(): void {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	// Clear any leftover AP/hotspot suppression markers from a prior test.
	for (const name of ["usb0", "usb1", "eth0", "eth1", "wwan0"]) {
		setNetifDupIpSuppression(name, false);
	}
}

beforeEach(() => {
	resetState();
});

describe("netif same-subnet detection (informational, AP-excluded)", () => {
	// Fixture (a): two modems on different IPs of the same /24 → both tagged with
	// the SAME same_subnet_group CIDR. Different IPs, same subnet is NOT an error
	// (policy routing handles it) — purely informational.
	test("two different-IP interfaces sharing a subnet get the same CIDR group", () => {
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("wwan0", "192.168.0.100"),
				ifconfigStanza("usb0", "192.168.0.101"),
			),
		);

		const msg = netIfBuildMsg();
		expect(msg.wwan0?.same_subnet_group).toBe("192.168.0.0/24");
		expect(msg.usb0?.same_subnet_group).toBe("192.168.0.0/24");
		// Same-subnet is NOT a dup-IP error — no error flag on either.
		expect(msg.wwan0?.error).toBeUndefined();
		expect(msg.usb0?.error).toBeUndefined();
	});

	// Fixture (b): the AP/hotspot interface is intentionally same-subnet with its
	// DHCP clients, so it must be EXCLUDED from grouping. It is identified the
	// same way the hotspot activation path marks it — dup-IP suppression
	// (wifi-hotspot-activation.ts:118-127 `setDupIpSuppression`). Neither the AP
	// nor its lone same-subnet peer gets tagged.
	test("the AP/hotspot interface is excluded from same-subnet grouping", () => {
		// usb0 plays the AP role: marked via the exact suppression mechanism the
		// hotspot activation path uses.
		setNetifDupIpSuppression("usb0", true);

		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("usb0", "192.168.0.1"),
				ifconfigStanza("eth0", "192.168.0.50"),
			),
		);

		const msg = netIfBuildMsg();
		// AP itself never carries a group.
		expect(msg.usb0?.same_subnet_group).toBeUndefined();
		// eth0's ONLY same-subnet peer is the excluded AP → eth0 is not tagged.
		expect(msg.eth0?.same_subnet_group).toBeUndefined();
	});

	// Fixture (c): an exact dup-IP pair (identical IPs) is a hard error
	// (NETIF_ERR_DUPIPV4) and must NOT ALSO fire a same-subnet tag. The dup-IP
	// behavior is completely unchanged; same-subnet never double-fires on it.
	test("an exact dup-IP pair gets the dup error only, no same-subnet tag", () => {
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("usb0", "192.168.0.100"),
				ifconfigStanza("eth0", "192.168.0.100"),
			),
		);

		const msg = netIfBuildMsg();
		// Dup-IP error is unchanged (both flagged).
		expect(msg.usb0?.error).toBe("duplicate IPv4 addr");
		expect(msg.eth0?.error).toBe("duplicate IPv4 addr");
		// No same-subnet tag double-fire on the dup-IP pair.
		expect(msg.usb0?.same_subnet_group).toBeUndefined();
		expect(msg.eth0?.same_subnet_group).toBeUndefined();
	});
});
