/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialNoticeLedger } from "../modules/system/update-orchestrator/credential-ledger.ts";

const DAY = 86_400_000;
const thresholds = { 90: "90", 30: "30", 7: "7", 0: "expired" } as const;
const known = {
	kind: "known",
	expiresAt: 200 * DAY,
	digest: "a".repeat(64),
} as const;
let root: string;
let path: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "credential-ledger-"));
	path = join(root, "ledger.json");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test.each([90, 30, 7] as const)(
	"%i-day exact millisecond boundaries",
	(days) => {
		// Given independent fresh journals; When each boundary is observed; Then only exact/inside crosses it.
		for (const delta of [1, 0, -1]) {
			const store = new CredentialNoticeLedger({
				path: join(root, `${days}-${delta}.json`),
			});
			const result = store.observe(known, known.expiresAt - days * DAY - delta);
			expect(result.current?.threshold).toBe(
				delta === 1
					? days === 90
						? undefined
						: days === 30
							? "90"
							: "30"
					: thresholds[days],
			);
		}
	},
);

test.each([1, 0, -1])("expiry boundary remaining %i ms", (remaining) => {
	// Given first boot near expiry; When evaluated; Then zero/negative is expired, not a negative-day warning.
	const store = new CredentialNoticeLedger({ path });
	expect(
		store.observe(known, known.expiresAt - remaining).current?.threshold,
	).toBe(remaining > 0 ? "7" : "expired");
});

test("offline catch-up records weaker facts as superseded and rehydrates the same urgent ID", async () => {
	// Given a first observation five days before expiry; When a fresh process reloads; Then only one stable urgent intent exists.
	const first = new CredentialNoticeLedger({ path }).observe(
		known,
		known.expiresAt - 5 * DAY,
	);
	const replay = new CredentialNoticeLedger({ path }).observe(
		known,
		known.expiresAt - 4 * DAY,
	);
	expect(replay.current).toEqual(first.current);
	const bytes = JSON.parse(await readFile(path, "utf8"));
	expect(bytes.generations[0].notices).toEqual({
		"90": "superseded",
		"30": "superseded",
		"7": "pending",
	});
});

test("dismissed 90-day warning stays acknowledged while 30/7/expired remain eligible", () => {
	// Given an acknowledged earlier threshold; When later thresholds cross; Then each has its own identity.
	const store = new CredentialNoticeLedger({ path });
	const first = store.observe(known, known.expiresAt - 80 * DAY).current;
	if (!first) throw new Error("missing fixture intent");
	store.acknowledge(first);
	expect(
		new CredentialNoticeLedger({ path }).observe(
			known,
			known.expiresAt - 70 * DAY,
		).current,
	).toBeUndefined();
	for (const days of [30, 7, 0] as const) {
		const next = store.observe(known, known.expiresAt - days * DAY).current;
		expect(next?.threshold).toBe(thresholds[days]);
		if (!next) throw new Error("missing fixture intent");
		store.acknowledge(next);
	}
});

test("forward and backward clock jumps never re-arm crossed thresholds", () => {
	// Given a late urgent crossing; When the clock jumps back then forward; Then superseded notices cannot reappear.
	const store = new CredentialNoticeLedger({ path });
	store.observe(known, known.expiresAt - 2 * DAY);
	expect(
		store.observe(known, known.expiresAt - 100 * DAY).current,
	).toBeUndefined();
	expect(
		store.observe(known, known.expiresAt - 2 * DAY).current,
	).toBeUndefined();
});

test("rotation retires old notices and rollback preserves acknowledgement identity", () => {
	// Given a dismissed certificate and distinct same-expiry replacement; When rolling back; Then no old warning resurrects.
	const store = new CredentialNoticeLedger({ path });
	const old = store.observe(known, known.expiresAt - DAY).current;
	if (!old) throw new Error("missing fixture intent");
	store.acknowledge(old);
	const newer = store.observe(
		{ ...known, digest: "b".repeat(64) },
		known.expiresAt - DAY,
	).current;
	expect(newer?.generation).not.toBe(old.generation);
	expect(
		new CredentialNoticeLedger({ path }).observe(known, known.expiresAt - DAY)
			.current,
	).toBeUndefined();
});

test.each(['{"schema":99}', '{"schema":1,"schema":1}', "damaged"])(
	"corrupt/unknown ledger defers without replacement %s",
	async (bytes) => {
		// Given unknown stored authority; When observing; Then preserve it and refuse publication.
		await writeFile(path, bytes);
		expect(() =>
			new CredentialNoticeLedger({ path }).observe(known, known.expiresAt),
		).toThrow();
		expect(await readFile(path, "utf8")).toBe(bytes);
	},
);

test("failed save before publication retains stable retry and directory acknowledgement", () => {
	// Given rename completed but parent sync failed; When a new instance retries; Then it reuses the renamed ID only after persistence succeeds.
	const fail = new CredentialNoticeLedger({
		path,
		syncParent: () => {
			throw new Error("fsync fault");
		},
	});
	expect(() => fail.observe(known, known.expiresAt)).toThrow();
	const recovered = new CredentialNoticeLedger({ path }).observe(
		known,
		known.expiresAt,
	).current;
	expect(recovered?.threshold).toBe("expired");
	expect(
		new CredentialNoticeLedger({ path }).observe(known, known.expiresAt)
			.current,
	).toEqual(recovered);
});
