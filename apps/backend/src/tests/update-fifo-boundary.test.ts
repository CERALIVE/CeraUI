import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["kernel-lock", "output"])(
	"%s no-writer FIFO refuses before blocking open",
	async (reader) => {
		const dir = mkdtempSync(join(tmpdir(), "fifo-boundary-"));
		const path = join(dir, "fifo");
		expect(await Bun.spawn(["mkfifo", "-m", "600", path]).exited).toBe(0);
		const info = lstatSync(path);
		const source =
			reader === "kernel-lock"
				? `
 const {readOsLockKernelDevice} = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-lock-device.ts"))});
 const value = await readOsLockKernelDevice(${JSON.stringify(path)}, ${JSON.stringify({ dev: info.dev, ino: info.ino })});
 if (value !== null) throw new Error("accepted FIFO"); console.log("refused");
 `
				: `
 const {spyOn} = await import("bun:test");
 const fs = (await import("node:fs/promises")).default; const native = fs.open;
 spyOn(fs, "open").mockImplementation((p,f,m) => native(p === "/run/ceralive/software-update.stdout" ? ${JSON.stringify(path)} : p,f,m));
 const {readSoftwareUpdateOutput, UnsafeSoftwareUpdateOutputPathError} = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/software-update-output.ts"))});
 try { await readSoftwareUpdateOutput("/run/ceralive/software-update.stdout",0); throw new Error("accepted FIFO"); }
 catch(error) { if (!(error instanceof UnsafeSoftwareUpdateOutputPathError)) throw error; console.log("refused"); }
 `;
		try {
			const child = Bun.spawn([process.execPath, "--eval", source], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const timer = setTimeout(() => child.kill(), 2000);
			const [output, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			clearTimeout(timer);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
			expect(output.trim()).toBe("refused");
			expect(lstatSync(path).ino).toBe(info.ino);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
