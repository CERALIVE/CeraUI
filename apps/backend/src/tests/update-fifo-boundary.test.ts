import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["kernel-lock", "output"])(
	"%s no-writer FIFO refuses before blocking open",
	async (reader) => {
		const dir = mkdtempSync(join(tmpdir(), "fifo-boundary-"));
		const path = join(dir, "fifo");
		const stderrPath = join(dir, "stderr");
		expect(await Bun.spawn(["mkfifo", "-m", "600", path]).exited).toBe(0);
		const info = lstatSync(path);
		const start = `
 await new Promise(resolve => {
   process.once("message", resolve);
   process.send("ready");
 });
 `;
		const source =
			reader === "kernel-lock"
				? `
 const {readOsLockKernelDevice} = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-lock-device.ts"))});
 ${start}
 const value = await readOsLockKernelDevice(${JSON.stringify(path)}, ${JSON.stringify({ dev: info.dev, ino: info.ino })});
 if (value !== null) throw new Error("accepted FIFO");
 `
				: `
 const {spyOn} = await import("bun:test");
 const fs = (await import("node:fs/promises")).default; const native = fs.open;
 spyOn(fs, "open").mockImplementation((p,f,m) => native(p === "/run/ceralive/software-update.stdout" ? ${JSON.stringify(path)} : p,f,m));
 const {readSoftwareUpdateOutput, UnsafeSoftwareUpdateOutputPathError} = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/software-update-output.ts"))});
 ${start}
 try { await readSoftwareUpdateOutput("/run/ceralive/software-update.stdout",0); throw new Error("accepted FIFO"); }
 catch(error) { if (!(error instanceof UnsafeSoftwareUpdateOutputPathError)) throw error; }
 `;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refused = Promise.withResolvers<string>();
		const exited = Promise.withResolvers<void>();
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					"--eval",
					`${source}
 process.send("refused");
 `,
				],
				{
					env: process.env,
					stdout: "ignore",
					stderr: Bun.file(stderrPath),
					ipc(message, child) {
						if (message === "ready") {
							timer = setTimeout(
								() =>
									refused.reject(new Error(`${reader} FIFO refusal timed out`)),
								2000,
							);
							child.send("read");
						}
						if (message === "refused") {
							clearTimeout(timer);
							refused.resolve(message);
						}
					},
					onExit(_child, code, signal, error) {
						exited.resolve();
						refused.reject(
							error ??
								new Error(
									`${reader} child exited before refusal (${code}, ${signal})`,
								),
						);
					},
				},
			);
			try {
				expect(await refused.promise).toBe("refused");
			} finally {
				clearTimeout(timer);
				child.kill("SIGKILL");
				await exited.promise;
			}
			expect(await Bun.file(stderrPath).text()).toBe("");
			expect(lstatSync(path).ino).toBe(info.ino);
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
