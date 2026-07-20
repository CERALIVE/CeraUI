/**
 * IPv4 link-local (APIPA / RFC 3927) classification — a DISPLAY hint, never a gate.
 *
 * The `169.254.0.0/16` range is the IANA link-local block. On CeraLive appliances
 * this address is DELIBERATE, not a fault: the shipped image sets
 * `ipv4.link-local=3` (enabled) scoped to the wired control port
 * (`/etc/NetworkManager/conf.d/ceralive.conf`), so NetworkManager ALWAYS keeps a
 * `169.254/16` address on `eth0` alongside any DHCP lease — guaranteeing the device
 * stays reachable at its `.local` mDNS name even when DHCP is dead. `ifconfig`
 * reports that link-local address FIRST, so the backend netif scan
 * (`network-interfaces.ts`, first-`inet`-match) surfaces it as the interface `ip`,
 * which to an operator looks like a stuck / hardcoded static IP that "cannot be
 * cleaned" (it re-appears on every reconnect because it is OS-managed, not a saved
 * CeraUI config). This predicate lets the UI label such an address honestly.
 */

const LINK_LOCAL_IPV4 = /^169\.254\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True when `ip` is an IPv4 link-local address (`169.254.0.0/16`). Tolerates
 * `undefined`/`null`/whitespace so call sites can pass a possibly-absent
 * interface IP directly. Octet-range checked so malformed values (e.g.
 * `169.254.999.1`) never match.
 */
export function isLinkLocalIpv4(ip: string | undefined | null): boolean {
	if (!ip) return false;
	const match = LINK_LOCAL_IPV4.exec(ip.trim());
	if (!match) return false;
	const third = Number(match[1]);
	const fourth = Number(match[2]);
	return third <= 255 && fourth <= 255;
}
