import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeviceEvent, EventBootRecord } from "@ceraui/rpc/schemas";

export function event(seq = 1, text = ""): DeviceEvent {
	return {
		id: `01234567-${seq}`,
		seq,
		bootId: "0123456789abcdef0123456789abcdef",
		at: 123456789 + seq,
		code: "link_down",
		family: "network",
		severity: "warning",
		params: { iface: "eth0", text },
	};
}

export function boot(text = ""): EventBootRecord {
	return {
		bootId: "0123456789abcdef0123456789abcdef",
		startedAt: 123456789,
		versions: {
			bootId: "0123456789abcdef0123456789abcdef",
			osImage: text,
			slot: "A",
			board: null,
			boardModel: null,
			ceraui: "2026.11.3",
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: "1.4.4",
		},
	};
}

export function line(record: DeviceEvent | EventBootRecord): string {
	return `${JSON.stringify({ v: 1, ...record })}\n`;
}

export function fixture() {
	const baseDir = fs.mkdtempSync(path.join(tmpdir(), "dls-events-"));
	const warnings: string[] = [];
	return {
		baseDir,
		warn: (message: string) => warnings.push(message),
		warnings,
		[Symbol.dispose]: () =>
			fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}
