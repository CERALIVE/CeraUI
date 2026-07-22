/**
 * Durable notification-dismissal store tests (device-quality-wave2 Todo 23c).
 *
 * The store records which notifications an operator dismissed, keyed by SEMANTIC
 * identity (for update notifications: the version string), so a dismissal
 * survives a page reload AND a backend restart. Requirements pinned here:
 *   - atomic write   — a kill mid-write leaves the OLD committed file valid
 *   - quarantine     — an unparseable file is renamed aside, store starts fresh
 *   - LRU bound      — exceeding the cap evicts the oldest dismissal
 *   - restart replay — a new instance loads the same keys off disk
 *   - semantic keys  — a NEW version key is not covered by an OLD dismissal
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NotificationDismissalStore } from "../modules/ui/notification-dismissals.ts";

let dir: string;
let storePath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceraui-dismissals-"));
	storePath = path.join(dir, "notification_dismissals.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("restart persistence + semantic keying", () => {
	it("a recorded dismissal is readable by a fresh instance (restart)", () => {
		const first = new NotificationDismissalStore({ path: storePath });
		first.load();
		first.recordDismissal("update:2026.7.3");

		const afterRestart = new NotificationDismissalStore({ path: storePath });
		afterRestart.load();
		expect(afterRestart.isDismissed("update:2026.7.3")).toBe(true);
	});

	it("a NEW version key is not covered by the OLD version's dismissal", () => {
		const store = new NotificationDismissalStore({ path: storePath });
		store.load();
		store.recordDismissal("update:2026.7.3");

		expect(store.isDismissed("update:2026.7.3")).toBe(true);
		expect(store.isDismissed("update:2026.7.4")).toBe(false);
	});
});

describe("atomic write", () => {
	it("a kill mid-write leaves the OLD committed file valid", () => {
		const committed = new NotificationDismissalStore({ path: storePath });
		committed.load();
		committed.recordDismissal("update:1.0.0");

		const crashingWrite = (target: string, contents: string): void => {
			const tmp = path.join(
				path.dirname(target),
				`.${path.basename(target)}.${process.pid}.tmp`,
			);
			fs.writeFileSync(tmp, contents.slice(0, contents.length >> 1));
			throw new Error("simulated crash before rename");
		};

		const crashing = new NotificationDismissalStore({
			path: storePath,
			deps: { writeAtomic: crashingWrite },
		});
		crashing.load();
		expect(() => crashing.recordDismissal("update:2.0.0")).toThrow();

		const recovered = new NotificationDismissalStore({ path: storePath });
		recovered.load();
		expect(recovered.isDismissed("update:1.0.0")).toBe(true);
		expect(recovered.isDismissed("update:2.0.0")).toBe(false);
	});
});

describe("corruption quarantine", () => {
	it("quarantines an unparseable file, starts fresh, logs, and never throws", () => {
		fs.writeFileSync(storePath, "{{{ not json at all");

		const quarantined: string[] = [];
		const logged: string[] = [];
		const store = new NotificationDismissalStore({
			path: storePath,
			deps: {
				logCorruption: (_p, corruptPath) => {
					quarantined.push(corruptPath);
					logged.push(corruptPath);
				},
			},
		});

		expect(() => store.load()).not.toThrow();
		expect(store.size()).toBe(0);
		expect(logged.length).toBe(1);

		const corruptFiles = fs
			.readdirSync(dir)
			.filter((f) => f.includes(".corrupt-"));
		expect(corruptFiles.length).toBe(1);
		expect(
			fs.readFileSync(path.join(dir, corruptFiles[0] as string), "utf8"),
		).toBe("{{{ not json at all");

		store.recordDismissal("update:3.0.0");
		expect(store.isDismissed("update:3.0.0")).toBe(true);
	});

	it("quarantines a well-formed-JSON-but-wrong-shape file", () => {
		fs.writeFileSync(storePath, JSON.stringify({ totally: "wrong" }));
		const store = new NotificationDismissalStore({ path: storePath });
		expect(() => store.load()).not.toThrow();
		expect(store.size()).toBe(0);
		expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
	});
});

describe("LRU bound", () => {
	it("evicts the oldest dismissal past the cap", () => {
		const store = new NotificationDismissalStore({
			path: storePath,
			maxEntries: 3,
		});
		store.load();
		store.recordDismissal("a");
		store.recordDismissal("b");
		store.recordDismissal("c");
		store.recordDismissal("d");

		expect(store.size()).toBe(3);
		expect(store.isDismissed("a")).toBe(false);
		expect(store.isDismissed("b")).toBe(true);
		expect(store.isDismissed("c")).toBe(true);
		expect(store.isDismissed("d")).toBe(true);
	});

	it("re-recording a key refreshes its recency so it survives eviction", () => {
		const store = new NotificationDismissalStore({
			path: storePath,
			maxEntries: 3,
		});
		store.load();
		store.recordDismissal("a");
		store.recordDismissal("b");
		store.recordDismissal("c");
		store.recordDismissal("a");
		store.recordDismissal("d");

		expect(store.isDismissed("a")).toBe(true);
		expect(store.isDismissed("b")).toBe(false);
		expect(store.size()).toBe(3);
	});

	it("enforces the cap when loading an over-cap file off disk", () => {
		const over = {
			version: 1,
			entries: [
				{ key: "a", dismissedAt: 1 },
				{ key: "b", dismissedAt: 2 },
				{ key: "c", dismissedAt: 3 },
				{ key: "d", dismissedAt: 4 },
			],
		};
		fs.writeFileSync(storePath, JSON.stringify(over));
		const store = new NotificationDismissalStore({
			path: storePath,
			maxEntries: 2,
		});
		store.load();
		expect(store.size()).toBe(2);
		expect(store.isDismissed("c")).toBe(true);
		expect(store.isDismissed("d")).toBe(true);
		expect(store.isDismissed("a")).toBe(false);
	});
});
