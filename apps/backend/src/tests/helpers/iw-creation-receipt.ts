// libnl debug framing; nl80211 NEW_INTERFACE replies carry native-endian TLVs.
export function iwCreationReceipt(
	ifname = "clap-wlan0",
	ifindex = 7,
	wdev = "0x7",
): string {
	const name = Buffer.from(`${ifname}\0`);
	const nameSize = (name.length + 7) & ~3;
	const payload = Buffer.alloc(8 + nameSize + 12);
	payload.writeUInt16LE(8, 0);
	payload.writeUInt16LE(3, 2); // NL80211_ATTR_IFINDEX
	payload.writeUInt32LE(ifindex, 4);
	payload.writeUInt16LE(name.length + 4, 8);
	payload.writeUInt16LE(4, 10); // NL80211_ATTR_IFNAME
	name.copy(payload, 12);
	payload.writeUInt16LE(12, 8 + nameSize);
	payload.writeUInt16LE(153, 10 + nameSize); // NL80211_ATTR_WDEV
	payload.writeBigUInt64LE(BigInt(wdev), 12 + nameSize);
	const hex: string[] = [];
	for (let offset = 0; offset < payload.length; offset += 16)
		hex.push(
			`    ${[...payload.subarray(offset, offset + 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ")} fixture`,
		);
	const header = "    .type = 43 <0x2b>\n    .seq = -42\n    .port = 123\n";
	return `-- Debug: Sent Message:\n${header}    .cmd = 7\n-- Debug: Received Message:\n${header}    .cmd = 7\n  [PAYLOAD] ${payload.length} octets\n${hex.join("\n")}\n--------------------------- END NETLINK MESSAGE\n`;
}
