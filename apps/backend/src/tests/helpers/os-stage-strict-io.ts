import { mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as spawnPolicy from "../../helpers/spawn-policy.ts";
import type { OsChannelManifest } from "../../modules/system/update-orchestrator/os-manifest.ts";

export async function strictStageIo(offered: OsChannelManifest) {
	const root = await fs.mkdtemp(join(tmpdir(), "os-pair-strict-"));
	let downloads = 0;
	let pointer = offered;
	const stateFiles = new Map([
		["/usr/lib/ceralive/update-capabilities.json", "capabilities"],
		["/etc/rauc/system.conf", "system.conf"],
		["/etc/ceralive/os-release-version", "version"],
		["/data/ceralive/update-state/manifest-serial.stable", "serial"],
	]);
	await Bun.write(
		join(root, "system.conf"),
		"[system]\ncompatible=ceralive-rock-5b-plus\n",
	);
	await Bun.write(join(root, "version"), "2026.10.50\n");
	await Bun.write(join(root, "serial"), "12\n");
	const capabilities = join(root, "capabilities");
	await Bun.write(
		capabilities,
		JSON.stringify({
			schema: 1,
			features: [
				"apt-all-packages",
				"rauc-verity-streaming",
				"transport-uidrange",
			],
			apt_uid: 42042,
			ota_uid: process.getuid?.(),
		}),
	);
	const file = Bun.file;
	spyOn(Bun, "file").mockImplementation((path, options) => {
		if (typeof path === "string") {
			const mapped = stateFiles.get(path);
			return file(mapped ? join(root, mapped) : path, options);
		}
		if (typeof path === "number") return file(path, options);
		if (path instanceof URL) return file(path, options);
		return file(path, options);
	});
	// Only privileged/network I/O is doubled; real file parsing and validation remain.
	spyOn(fs, "chown").mockResolvedValue(undefined);
	spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(async (argv) => {
		let stdout = "";
		let exitCode = 0;
		switch (argv[0]) {
			case "id":
				stdout = String(process.getuid?.());
				break;
			case "runuser": {
				const target = argv[argv.indexOf("--output") + 1];
				if (!target) throw new Error("missing fetch target");
				downloads++;
				await Bun.write(
					target,
					target.endsWith(".json")
						? JSON.stringify(pointer)
						: new Uint8Array([1]),
				);
				break;
			}
			case "openssl": {
				if (argv.includes("-verify")) {
					const target = argv[argv.indexOf("-signer") + 1];
					if (!target) throw new Error("missing signer target");
					await Bun.write(target, "-----BEGIN CERTIFICATE-----\nfixture\n");
				} else if (argv.includes("-subject"))
					stdout = "subject=CN=CeraLive OTA Manifest Signer\n";
				else if (argv.includes("-issuer"))
					stdout = "issuer=CN=CeraLive RAUC Intermediate CA,O=CeraLive\n";
				else stdout = "X509v3 Extended Key Usage:\nCode Signing\n";
				break;
			}
			case "dpkg-query":
				stdout = "2026.9.3";
				break;
			case "dpkg":
				exitCode = argv[2] && argv[4] && argv[2] > argv[4] ? 0 : 1;
				break;
			default:
				throw new Error(`unexpected command: ${argv.join(" ")}`);
		}
		return { exitCode, stdout, stderr: "" };
	});
	return {
		capabilities,
		expire: () => {
			pointer = { ...offered, expires_at: "2000-01-01T00:00:00Z" };
		},
		downloads: () => downloads,
		[Symbol.asyncDispose]: async () => {
			mock.restore();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
