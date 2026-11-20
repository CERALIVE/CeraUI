import fs from "node:fs";
import path from "node:path";
import type { DeviceEvent, EventBootRecord } from "@ceraui/rpc/schemas";
import {
	appendBoot,
	appendEvent,
	type EventStoreDeps,
	readBoots,
	readEvents,
} from "../modules/events/store.ts";
import { boot, event, line } from "./events-store.fixtures.ts";

export const rings = [
	{ name: "events", bytes: 512 * 1024, files: 8 },
	{ name: "boots", bytes: 128 * 1024, files: 2 },
] as const;
export type TestRing = (typeof rings)[number];
export type TestRecord = DeviceEvent | EventBootRecord;

export function record(ring: TestRing, seq: number, text = ""): TestRecord {
	return ring.name === "events"
		? event(seq, text)
		: { ...boot(text), startedAt: seq };
}

export function sequence(value: TestRecord): number {
	return "seq" in value ? value.seq : value.startedAt;
}

export function ringPath(base: string, ring: TestRing, generation = 0): string {
	return path.join(
		base,
		generation ? `${ring.name}.${generation}.jsonl` : `${ring.name}.jsonl`,
	);
}

export function paddedFile(value: TestRecord, bytes: number): string {
	const encoded = line(value);
	return `${encoded.slice(0, -1)}${" ".repeat(bytes - Buffer.byteLength(encoded))}\n`;
}

export function sizedRecord(
	ring: TestRing,
	size: {
		readonly bytes: number;
		readonly seq: number;
		readonly unicode?: boolean;
	},
): TestRecord {
	const padding = size.bytes - Buffer.byteLength(line(record(ring, size.seq)));
	const text = size.unicode
		? `${"é".repeat(Math.floor(padding / 2))}${"x".repeat(padding % 2)}`
		: "x".repeat(padding);
	return record(ring, size.seq, text);
}

export function append(value: TestRecord, deps: EventStoreDeps): void {
	if ("seq" in value) appendEvent(value, { ...deps, sync: false });
	else appendBoot(value, deps);
}

export function readRing(ring: TestRing, deps: EventStoreDeps): TestRecord[] {
	return ring.name === "events" ? readEvents(deps) : readBoots(deps);
}

export function seed(ring: TestRing, baseDir: string): TestRecord[] {
	const oldestFirst: TestRecord[] = [];
	for (let generation = ring.files - 1; generation >= 0; generation--) {
		const value = record(ring, ring.files - generation);
		fs.writeFileSync(
			ringPath(baseDir, ring, generation),
			paddedFile(value, ring.bytes),
		);
		oldestFirst.push(value);
	}
	return oldestFirst;
}

export function diskSnapshot(
	baseDir: string,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		fs
			.readdirSync(baseDir)
			.sort()
			.map((name) => [
				name,
				new Bun.CryptoHasher("sha256")
					.update(fs.readFileSync(path.join(baseDir, name)))
					.digest("hex"),
			]),
	);
}
