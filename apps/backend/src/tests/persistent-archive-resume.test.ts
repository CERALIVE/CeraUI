import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveDamagedRecord } from "../helpers/persistent-record.ts";

const DIGEST =
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const bytes = Buffer.from("abc");
const eio = Object.assign(new Error("EIO cleanup"), { code: "EIO" });
let root: string;
let path: string;
let copy: string;
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "archive-resume-"));
	path = join(root, "config.json");
	copy = `${path}.damaged-${DIGEST}`;
	fs.writeFileSync(path, bytes);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("one cleanup EIO does not become eight EEXIST preservation failures", () => {
	// Given one failed unlink after publication, then healthy storage.
	const unlink = fs.unlinkSync;
	let calls = 0;
	const fault = spyOn(fs, "unlinkSync").mockImplementation((p) => {
		if (++calls === 1) throw eio;
		return unlink(p);
	});
	try {
		// When the same helper is retried through both partial-state boundaries.
		const outcomes: (string | null)[] = [];
		for (let n = 0; n < 9; n++) {
			try {
				preserveDamagedRecord(path, bytes);
				outcomes.push(null);
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error)) throw error;
				outcomes.push(String(error.code));
			}
		}
		// Then only the first attempt fails and cleanup remains retry-owned.
		expect(outcomes).toEqual([
			"EIO",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
		expect(calls).toBe(2);
		expect(fs.readdirSync(root).sort()).toEqual([
			"config.json",
			`config.json.damaged-${DIGEST}`,
		]);
		expect(fs.readFileSync(path, "utf8")).toBe("abc");
		expect(fs.readFileSync(copy, "utf8")).toBe("abc");
	} finally {
		fault.mockRestore();
	}
});

test("published copy reuse needs no temp allocation but reacknowledges the parent", () => {
	// Given published bytes and an old same-PID temp from an earlier lifetime.
	fs.writeFileSync(copy, bytes);
	const stale = join(root, `.config.json.damaged-${DIGEST}.${process.pid}.tmp`);
	fs.writeFileSync(stale, "old debris");
	const write = spyOn(fs, "writeSync").mockImplementation(() => {
		throw eio;
	});
	const sync = spyOn(fs, "fsyncSync");
	try {
		// When reuse runs without writable temp storage.
		expect(preserveDamagedRecord(path, bytes)).toBe(copy);
		// Then durability is acknowledged without replacing either piece of evidence.
		expect(write).not.toHaveBeenCalled();
		expect(sync).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(stale, "utf8")).toBe("old debris");
		expect(fs.readFileSync(copy, "utf8")).toBe("abc");
	} finally {
		write.mockRestore();
		sync.mockRestore();
	}
});

test("unpublished cleanup EIO retains one owned temp across nine retries", () => {
	// Given a temp-fsync fault and persistent unlink EIO.
	const sync = fs.fsyncSync;
	const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (fs.fstatSync(fd).isFile()) throw eio;
		return sync(fd);
	});
	const cleanup = spyOn(fs, "unlinkSync").mockImplementation(() => {
		throw eio;
	});
	try {
		// When both failures repeat, and then storage is repaired.
		for (let n = 0; n < 9; n++)
			expect(() => preserveDamagedRecord(path, bytes)).toThrow("EIO");
		expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toHaveLength(
			1,
		);
		expect(fs.readdirSync(root).filter((n) => !n.endsWith(".tmp"))).toEqual([
			"config.json",
		]);
		fault.mockRestore();
		cleanup.mockRestore();
		preserveDamagedRecord(path, bytes);
		// Then the owned temp is reclaimed before another allocation; no evidence is lost.
		expect(fs.readdirSync(root).sort()).toEqual([
			"config.json",
			`config.json.damaged-${DIGEST}`,
		]);
		expect(fs.readFileSync(copy, "utf8")).toBe("abc");
	} finally {
		fault.mockRestore();
		cleanup.mockRestore();
	}
});

test("cleanup never deletes a replacement inode even with identical bytes", () => {
	// Given an own published temp whose first cleanup failed.
	const cleanup = spyOn(fs, "unlinkSync").mockImplementation(() => {
		throw eio;
	});
	expect(() => preserveDamagedRecord(path, bytes)).toThrow("EIO");
	cleanup.mockRestore();
	const name = fs.readdirSync(root).find((n) => n.endsWith(".tmp"));
	expect(name).toBeDefined();
	if (name === undefined) throw new Error("missing fixture temp");
	const temp = join(root, name);
	fs.renameSync(temp, join(root, "retained-inode"));
	fs.writeFileSync(temp, bytes);
	// When retry reuses the published copy after a replacement interleaving.
	preserveDamagedRecord(path, bytes);
	// Then equal bytes never substitute for recorded file identity.
	expect(fs.readFileSync(temp, "utf8")).toBe("abc");
	expect(fs.readFileSync(join(root, "retained-inode"), "utf8")).toBe("abc");
	expect(fs.readFileSync(copy, "utf8")).toBe("abc");
});

test("a conflicting published digest name is never overwritten or deleted", () => {
	// Given a published name with different bytes (corruption/foreign evidence).
	fs.writeFileSync(copy, "xyz");
	// When preservation encounters it repeatedly.
	for (let n = 0; n < 9; n++)
		expect(() => preserveDamagedRecord(path, bytes)).toThrow();
	// Then both originals stay byte-exact, without accumulating temps.
	expect(fs.readFileSync(copy, "utf8")).toBe("xyz");
	expect(fs.readFileSync(path, "utf8")).toBe("abc");
	expect(fs.readdirSync(root).sort()).toEqual([
		"config.json",
		`config.json.damaged-${DIGEST}`,
	]);
});
