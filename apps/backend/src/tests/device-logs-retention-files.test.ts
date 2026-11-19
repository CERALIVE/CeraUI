import { expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as io from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("counts current and predecessor directories without following directory links", async () => {
	const { journalDirectoryBytes } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-files-"));
	try {
		mkdirSync(join(dir, "current"));
		mkdirSync(join(dir, "predecessor"));
		writeFileSync(join(dir, "current", "active"), "abc");
		writeFileSync(join(dir, "predecessor", "archive"), "12345");
		symlinkSync(dir, join(dir, "cycle"));
		expect(await journalDirectoryBytes(dir)).toBe(8);
		expect(await journalDirectoryBytes(join(dir, "absent"))).toBeNull();
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test.each([
	new Error("EACCES"),
	"fault",
	{ code: "EACCES" },
	{ code: "ENOENT" },
])("propagates non-absence legacy filesystem errors: %j", async (error) => {
	const { legacyDebugBytes, deleteLegacyDebugFiles } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const size = spyOn(io, "stat").mockRejectedValue(error);
	const remove = spyOn(io, "unlink").mockRejectedValue(error);
	try {
		await expect(legacyDebugBytes()).rejects.toEqual(error);
		await expect(deleteLegacyDebugFiles()).rejects.toEqual(error);
	} finally {
		size.mockRestore();
		remove.mockRestore();
	}
});

test("journal accounting reads the fixed native directory by default", async () => {
	const { journalDirectoryBytes } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const read = spyOn(io, "readdir").mockRejectedValue(new Error("denied"));
	try {
		expect(await journalDirectoryBytes()).toBeNull();
		expect(read).toHaveBeenCalledWith("/var/log/journal", {
			withFileTypes: true,
		});
	} finally {
		read.mockRestore();
	}
});

test("a failing nested journal traversal remains unknown", async () => {
	const { journalDirectoryBytes } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-files-"));
	mkdirSync(join(dir, "nested"));
	writeFileSync(join(dir, "nested", "file"), "x");
	const size = spyOn(io, "stat").mockRejectedValue(new Error("denied"));
	try {
		expect(await journalDirectoryBytes(dir)).toBeNull();
	} finally {
		size.mockRestore();
		rmSync(dir, { recursive: true });
	}
});

test("deletes exactly six legacy debug files and preserves other evidence", async () => {
	const { legacyDebugBytes, deleteLegacyDebugFiles } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-files-"));
	try {
		for (const name of [
			"debug.log",
			"debug1.log",
			"debug2.log",
			"debug3.log",
			"debug4.log",
			"debug5.log",
		])
			writeFileSync(join(dir, name), "four");
		writeFileSync(join(dir, "debug6.log"), "kept");
		writeFileSync(join(dir, "events.jsonl"), "event");
		expect(await legacyDebugBytes(dir)).toBe(24);
		await deleteLegacyDebugFiles(dir);
		expect(await legacyDebugBytes(dir)).toBe(0);
		expect(readFileSync(join(dir, "debug6.log"), "utf8")).toBe("kept");
		expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe("event");
		await deleteLegacyDebugFiles(dir);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("does not conceal a failed legacy deletion or size read", async () => {
	const { legacyDebugBytes, deleteLegacyDebugFiles } = await import(
		"../modules/device-logs/retention-files.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-files-"));
	try {
		mkdirSync(join(dir, "debug.log"));
		await expect(deleteLegacyDebugFiles(dir)).rejects.toThrow();
		symlinkSync(join(dir, "missing"), join(dir, "debug1.log"));
		// A missing rotated file is harmless, including a vanished symlink target.
		expect(await legacyDebugBytes(dir)).toBe(0);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
