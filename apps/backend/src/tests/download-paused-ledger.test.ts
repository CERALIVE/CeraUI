import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadPausedLedger } from "../modules/system/update-orchestrator/download-paused-ledger.ts";

const roots: string[] = [];
function fixture(sync?: (path: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "download-ledger-"));
	roots.push(root);
	const path = join(root, "ledger.json");
	return { path, ledger: new DownloadPausedLedger(path, sync) };
}
const entry = {
	id: "packages:11111111-1111-4111-8111-111111111111",
	candidate: "a".repeat(64),
	status: "active" as const,
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("download hold ledger", () => {
	test("commits a restart-readable intent and acknowledgement", () => {
		const { ledger, path } = fixture();
		expect(ledger.read()).toEqual([]);
		ledger.write([entry]);
		expect(new DownloadPausedLedger(path).read()).toEqual([entry]);
		ledger.acknowledge(entry.id);
		expect(new DownloadPausedLedger(path).read()).toEqual([
			{ ...entry, status: "acknowledged" },
		]);
	});
	test.each([
		"{",
		'{"schema":2,"entries":[]}',
		'{"schema":1,"entries":[],"foreign":true}',
		'{"schema":1,"schema":1,"entries":[]}',
		'{"schema":1,"entries":[{}]}',
	])("preserves unknown authority %s", (raw) => {
		const { ledger, path } = fixture();
		writeFileSync(path, raw);
		expect(() => ledger.read()).toThrow();
		expect(() => ledger.acknowledge(entry.id)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(raw);
	});
	test("does not acknowledge a renamed write without parent synchronization", () => {
		const { ledger, path } = fixture(() => {
			throw new Error("synthetic fsync failure");
		});
		expect(() => ledger.write([entry])).toThrow("synthetic fsync failure");
		expect(new DownloadPausedLedger(path).read()).toEqual([entry]);
	});
	test("refuses overflow rather than evicting attempt acknowledgements", () => {
		const { ledger } = fixture();
		ledger.write([entry]);
		expect(() =>
			ledger.write(Array.from({ length: 4097 }, () => entry)),
		).toThrow();
		expect(ledger.read()).toEqual([entry]);
	});
});
