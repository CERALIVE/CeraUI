import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveDamagedRecord } from "../helpers/persistent-record.ts";

test.each(["write", "temp-fsync", "link", "directory-fsync"] as const)(
	"damaged archive keeps retry storage bounded after %s failure",
	async (fault) => {
		// Given a real private directory and a 1 MiB + 1 damaged record.
		const root = fs.mkdtempSync(join(tmpdir(), "archive-cleanup-"));
		const path = join(root, "config.json");
		const bytes = Buffer.alloc(1_048_577, 123);
		fs.writeFileSync(path, bytes);
		const error = Object.assign(new Error("EIO"), { code: "EIO" });
		const originalSync = fs.fsyncSync;
		const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			const isFile = fs.fstatSync(fd).isFile();
			if (
				(fault === "temp-fsync" && isFile) ||
				(fault === "directory-fsync" && !isFile)
			)
				throw error;
			return originalSync(fd);
		});
		const write =
			fault === "write"
				? spyOn(fs, "writeSync").mockImplementation(() => {
						throw error;
					})
				: undefined;
		const link =
			fault === "link"
				? spyOn(fs, "linkSync").mockImplementation(() => {
						throw error;
					})
				: undefined;
		try {
			// When the production preservation boundary retries eight times.
			for (let attempt = 0; attempt < 8; attempt++)
				expect(() => preserveDamagedRecord(path, bytes)).toThrow("EIO");
			// Then no unpublished temp survives; at most one published copy awaits durability.
			const names = fs.readdirSync(root);
			expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
			const copies = names.filter((n) => n.includes(".damaged-"));
			expect(copies).toHaveLength(fault === "directory-fsync" ? 1 : 0);
			expect(
				names.reduce((sum, n) => sum + fs.statSync(join(root, n)).size, 0),
			).toBe(fault === "directory-fsync" ? 2_097_154 : 1_048_577);
			expect(fs.readFileSync(path).equals(bytes)).toBe(true);
			sync.mockRestore();
			write?.mockRestore();
			link?.mockRestore();
			const copy = preserveDamagedRecord(path, bytes);
			expect(fs.readFileSync(copy).equals(bytes)).toBe(true);
			expect(
				fs.readdirSync(root).filter((n) => n.includes(".damaged-")),
			).toHaveLength(1);
		} finally {
			sync.mockRestore();
			write?.mockRestore();
			link?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);
