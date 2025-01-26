function ipToLong(ip: string) {
	return ip
		.split(".")
		.reduce((acc, octet) => (acc << 8) | Number.parseInt(octet, 10), 0);
}

export function isSameNetwork(ip1: string, ip2: string, netmask: string) {
	const ip1Long = ipToLong(ip1);
	const ip2Long = ipToLong(ip2);
	const netmaskLong = ipToLong(netmask);

	return (ip1Long & netmaskLong) === (ip2Long & netmaskLong);
}
