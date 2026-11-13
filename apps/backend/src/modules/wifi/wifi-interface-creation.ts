import { endianness } from "node:os";

export type CreatedInterface = {
	readonly ifindex: string;
	readonly wdev: string;
};

function field(message: string, name: string): string | undefined {
	return message.match(new RegExp(`\\.${name} = (-?\\d+)\\b`))?.[1];
}

/** Only the NEW_INTERFACE reply to this command can confer cleanup authority. */
export function createdInterfaceReceipt(
	debug: string,
	ifname: string,
): CreatedInterface | undefined {
	const messages = debug.split(/^-- Debug: /m);
	const requests = messages.filter(
		(message) =>
			message.startsWith("Sent Message:") && field(message, "cmd") === "7",
	);
	const request = requests[0];
	if (!request || requests.length !== 1) return undefined;
	const replies = messages.filter(
		(message) =>
			message.startsWith("Received Message:") &&
			field(message, "cmd") === "7" &&
			["type", "seq", "port"].every(
				(name) =>
					field(request, name) !== undefined &&
					field(request, name) === field(message, name),
			),
	);
	const reply = replies[0];
	if (!reply || replies.length !== 1) return undefined;
	const payload = reply.match(/\[PAYLOAD\] (\d+) octets\n([\s\S]*?)^-{5}/m);
	if (!payload?.[2]) return undefined;
	const hex = payload[2]
		.split("\n")
		.map(
			(line) => line.match(/^\s{4}((?:[0-9a-f]{2}(?: |$)){1,16})/i)?.[1] ?? "",
		)
		.join("")
		.replaceAll(" ", "");
	const bytes = Buffer.from(hex, "hex");
	if (bytes.length !== Number(payload[1])) return undefined;
	const little = endianness() === "LE";
	const attributes = new Map<number, Buffer>();
	for (let offset = 0; offset < bytes.length; ) {
		if (offset + 4 > bytes.length) return undefined;
		const size = little
			? bytes.readUInt16LE(offset)
			: bytes.readUInt16BE(offset);
		const kind =
			(little
				? bytes.readUInt16LE(offset + 2)
				: bytes.readUInt16BE(offset + 2)) & 0x3fff;
		if (size < 4 || offset + size > bytes.length) return undefined;
		// Frozen nl80211 UAPI: IFINDEX=3, IFNAME=4, WDEV=153.
		if (kind === 3 || kind === 4 || kind === 153) {
			if (attributes.has(kind)) return undefined;
			attributes.set(kind, bytes.subarray(offset + 4, offset + size));
		}
		offset += (size + 3) & ~3;
		if (offset > bytes.length) return undefined;
	}
	const index = attributes.get(3);
	const name = attributes.get(4);
	const device = attributes.get(153);
	if (
		index?.length !== 4 ||
		device?.length !== 8 ||
		name?.toString() !== `${ifname}\0`
	)
		return undefined;
	const ifindex = little ? index.readUInt32LE() : index.readUInt32BE();
	const wdev = little ? device.readBigUInt64LE() : device.readBigUInt64BE();
	return ifindex > 0 && wdev > 0n
		? { ifindex: String(ifindex), wdev: `0x${wdev.toString(16)}` }
		: undefined;
}
