import { expect, test } from "bun:test";
import { lstat, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NmProfileInstance } from "../modules/network/network-manager-profile-instance.ts";
import { classifyHotspotProfileReadback } from "../modules/wifi/wifi-hotspot-profile-readback.ts";

async function instance(filename: string): Promise<NmProfileInstance> {
	const stat = await lstat(filename, { bigint: true });
	return {
		runId: "run",
		path: "/Settings/1",
		fingerprint: "selected-settings",
		file: {
			filename,
			device: String(stat.dev),
			inode: String(stat.ino),
			ctime: String(stat.ctimeNs),
		},
	};
}

for (const boundary of ["none", "path", "run", "filename", "lossy-utf8"]) {
	test(`profile timestamp allowance requires continuity and lossless bytes: ${boundary}`, async () => {
		const prefix = Buffer.from("[connection]\nid=");
		const suffix = Buffer.from("\n[wifi]\nmode=ap\n");
		const predicted = Buffer.concat([
			prefix,
			boundary === "lossy-utf8" ? Buffer.from([0xff]) : Buffer.from("x"),
			suffix,
		]);
		const observed = Buffer.concat([
			prefix,
			boundary === "lossy-utf8" ? Buffer.from([0xfe]) : Buffer.from("x"),
			Buffer.from("\ntimestamp=42"),
			suffix,
		]);
		const dir = await mkdtemp(join(tmpdir(), "wifi-profile-boundary-"));
		const filename = join(dir, "profile.nmconnection");
		await writeFile(filename, predicted, { mode: 0o600 });
		const before = await instance(filename);
		const held = { handle: await open(filename, "r+"), bytes: predicted };
		try {
			const target =
				boundary === "filename" ? join(dir, "other.nmconnection") : filename;
			await writeFile(join(dir, "next"), observed, { mode: 0o600 });
			await rename(join(dir, "next"), target);
			const actual = await instance(target);
			const after = {
				...actual,
				...(boundary === "path" ? { path: "/Settings/2" } : {}),
				...(boundary === "run" ? { runId: "new-run" } : {}),
			};
			const result = await classifyHotspotProfileReadback(
				{
					kind: "modify",
					before,
					held,
					predicted,
					acknowledged: true,
					fields: { "connection.autoconnect": "no" },
				},
				after,
				{ activationTimestamp: "42" },
			);
			expect(result.checked).toBe(boundary === "none");
			expect(result.exit).toBe(
				boundary === "none"
					? undefined
					: boundary === "lossy-utf8"
						? "modify-prediction-mismatch"
						: "modify-success-continuity-lost",
			);
		} finally {
			await held.handle.close();
			await rm(dir, { recursive: true });
		}
	});
}
