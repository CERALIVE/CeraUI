import { expect, spyOn, test } from "bun:test";
import { constants, lstatSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredStateJson } from "../modules/system/update-orchestrator/stored-state-file.ts";
import { parseAuthorityJson } from "../modules/system/update-orchestrator/strict-authority-json.ts";

const cases = [
	"absent",
	"missing-directory",
	"directory",
	"dangling-leaf",
	"dangling-parent",
	"loop",
	"fifo",
	"fifo-writer",
	"EACCES",
	"EIO",
	"truncated",
	"BOM",
	"invalid-utf8",
	"duplicate",
	"nested-duplicate",
	"oversize",
	"valid",
] as const;
test.each([...cases])("strict stored authority matrix: %s", async (kind) => {
	const dir = mkdtempSync(join(tmpdir(), "stored-authority-"));
	let path = join(dir, "authority");
	let writer: Awaited<ReturnType<typeof fs.open>> | undefined;
	let openSpy: ReturnType<typeof spyOn<typeof fs, "open">> | undefined;
	const native = fs.open;
	try {
		switch (kind) {
			case "absent":
				break;
			case "missing-directory":
				path = join(dir, "fresh/authority");
				break;
			case "directory":
				await fs.mkdir(path);
				break;
			case "dangling-leaf":
				await fs.symlink(join(dir, "gone"), path);
				break;
			case "dangling-parent":
				await fs.symlink(join(dir, "gone"), join(dir, "parent"));
				path = join(dir, "parent/authority");
				break;
			case "loop":
				await fs.symlink(path, path);
				break;
			case "fifo":
			case "fifo-writer":
				expect(await Bun.spawn(["mkfifo", "-m", "600", path]).exited).toBe(0);
				if (kind === "fifo-writer")
					writer = await fs.open(path, constants.O_RDWR | constants.O_NONBLOCK);
				break;
			case "EACCES":
				await fs.writeFile(path, '{"ok":true}', { mode: 0 });
				break;
			case "EIO":
				await fs.writeFile(path, '{"ok":true}');
				openSpy = spyOn(fs, "open").mockImplementation((entry, flags, mode) =>
					typeof entry === "string" && entry.endsWith("/authority")
						? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))
						: native(entry, flags, mode),
				);
				break;
			case "truncated":
				await fs.writeFile(path, '{"ok":');
				break;
			case "BOM":
				await fs.writeFile(path, '\ufeff{"ok":true}');
				break;
			case "invalid-utf8":
				await fs.writeFile(path, Buffer.from([0xff]));
				break;
			case "duplicate":
				await fs.writeFile(path, '{"ok":false,"ok":true}');
				break;
			case "nested-duplicate":
				await fs.writeFile(path, '{"outer":[{"ok":false,"ok":true}]}');
				break;
			case "oversize":
				await fs.writeFile(path, '{"ok":true}' + " ".repeat(4096));
				break;
			case "valid":
				await fs.writeFile(
					path,
					' {\n "ok": true, "nested": [{"value":"{\\"x\\":1}"}]\n }\n',
				);
				break;
			default:
				throw new Error(kind satisfies never);
		}
		const before = await fs.lstat(path).catch(() => null);
		if (kind === "fifo" || kind === "fifo-writer") {
			const source = `const {readStoredStateJson,StoredStateReadError} = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/stored-state-file.ts"))}); try {await readStoredStateJson(${JSON.stringify(path)},4096); throw new Error("accepted FIFO");} catch(error) {if (!(error instanceof StoredStateReadError)) throw error; console.log("refused");}`;
			const child = Bun.spawn([process.execPath, "--eval", source], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const timer = setTimeout(() => child.kill(), 2000);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			clearTimeout(timer);
			expect({ stdout: stdout.trim(), stderr, exit }).toEqual({
				stdout: "refused",
				stderr: "",
				exit: 0,
			});
		} else if (kind === "absent" || kind === "missing-directory")
			expect(await readStoredStateJson(path, 4096)).toBeUndefined();
		else if (kind === "valid")
			expect(await readStoredStateJson(path, 4096)).toMatchObject({ ok: true });
		else await expect(readStoredStateJson(path, 4096)).rejects.toThrow();
		if (before) expect(lstatSync(path).ino).toBe(before.ino);
	} finally {
		openSpy?.mockRestore();
		await writer?.close();
		await fs.chmod(path, 0o600).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	'{"phase":1,"\\u0070hase":2}',
	'{"a":{"x":1,"x":2}}',
	'[{"a":1,"a":2}]',
])("raw decoded duplicate member refuses %s", (raw) => {
	expect(() => parseAuthorityJson(raw)).toThrow();
});
test.each([
	'{"a":{"x":1},"b":{"x":2}}',
	'[{"a":1},{"a":2}]',
	'{"braces":"{}[]","slash":"\\\\","quote":"\\""}',
])("independent objects and escaped strings remain valid %s", (raw) => {
	expect(parseAuthorityJson(raw)).toEqual(JSON.parse(raw));
});
