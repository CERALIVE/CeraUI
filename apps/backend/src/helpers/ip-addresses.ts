export function ipToInt(ip: string) {
	return ip.split(".").reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
}

export function isSameSubnet(ip1: string, ip2: string, netmask: string) {
	const ip1Int = ipToInt(ip1);
	const ip2Int = ipToInt(ip2);
	const netmaskInt = ipToInt(netmask);

	return (ip1Int & netmaskInt) === (ip2Int & netmaskInt);
}

const localIpPatterns = [
	/^127\./, // Loopback addresses
	/^10\./, // Class A private addresses
	/^192\.168\./, // Class C private addresses
	/^172\.(1[6-9]|2\d|3[0-1])\./, // Class B private addresses (172.16.0.0 - 172.31.255.255)
	/^169\.254\./, // Link-local addresses
];

export function isLocalIp(ip: string) {
	return localIpPatterns.some((pattern) => pattern.test(ip));
}
