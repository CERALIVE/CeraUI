import { SteeringUnavailableError } from "./contracts.ts";

export function subnetCidr(ip: string, netmask: string): string {
	const mask = ipv4ToInt(netmask);
	const hostBits = ~mask >>> 0;
	if ((hostBits & ((hostBits + 1) >>> 0)) !== 0) {
		throw new SteeringUnavailableError(
			"overlapping_subnet",
			`invalid non-contiguous netmask: ${netmask}`,
		);
	}
	return `${intToIpv4(ipv4ToInt(ip) & mask)}/${popcount(mask)}`;
}

export function cidrsOverlap(left: string, right: string): boolean {
	const a = cidrRange(left);
	const b = cidrRange(right);
	return a.start <= b.end && b.start <= a.end;
}

function cidrRange(cidr: string): { start: number; end: number } {
	const [ip = "", prefixText = ""] = cidr.split("/");
	const prefix = Number.parseInt(prefixText, 10);
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const start = (ipv4ToInt(ip) & mask) >>> 0;
	return { start, end: (start | (~mask >>> 0)) >>> 0 };
}

function ipv4ToInt(ip: string): number {
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		throw new SteeringUnavailableError(
			"overlapping_subnet",
			`invalid IPv4 address: ${ip}`,
		);
	}
	return (
		(((parts[0] ?? 0) << 24) |
			((parts[1] ?? 0) << 16) |
			((parts[2] ?? 0) << 8) |
			(parts[3] ?? 0)) >>>
		0
	);
}

function intToIpv4(value: number): string {
	return [
		value >>> 24,
		(value >>> 16) & 255,
		(value >>> 8) & 255,
		value & 255,
	].join(".");
}

function popcount(value: number): number {
	let count = 0;
	for (let bits = value >>> 0; bits !== 0; bits >>>= 1) count += bits & 1;
	return count;
}
