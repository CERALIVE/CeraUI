/// <reference types="bun" />
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aptClientPaths } from "../modules/addons/apt-client-tls.ts";
import {
	defaultCredentialExpiryDeps,
	readCredentialExpiry,
} from "../modules/system/update-orchestrator/credential-expiry.ts";
import { credentialFixture } from "./helpers/credential-fixture.ts";

let fixture: Awaited<ReturnType<typeof credentialFixture>>;
beforeAll(async () => {
	fixture = await credentialFixture();
});
afterAll(async () => {
	await fixture.cleanup();
});

test.each(["client.crt", "client.key"])(
	"dangling packaged %s selects the same legacy pair as TLS",
	async (dangling) => {
		// Given a dangling package entry and a complete legacy pair; no key contents are read.
		const root = join(fixture.root, dangling);
		await mkdir(join(root, "packaged"), { recursive: true });
		await mkdir(join(root, "legacy"));
		const localPath = (path: string) =>
			join(
				root,
				path.startsWith("/usr/share/") ? "packaged" : "legacy",
				path.split("/").at(-1) ?? "",
			);
		for (const name of ["client.crt", "client.key"]) {
			await writeFile(
				join(root, "legacy", name),
				name === "client.crt" ? fixture.pem : "",
			);
			if (name === dangling)
				await symlink(join(root, "absent"), join(root, "packaged", name));
			else
				await writeFile(
					join(root, "packaged", name),
					name === "client.crt" ? fixture.pem : "",
				);
		}
		const consumer = await aptClientPaths((path) =>
			Bun.file(localPath(path)).exists(),
		);
		const reads: string[] = [];
		// When the reader's actual default existence probe is mapped to that private layout.
		const result = await readCredentialExpiry({
			exists: (path) => defaultCredentialExpiryDeps.exists(localPath(path)),
			readPublic: (path, limit) => {
				reads.push(path);
				return defaultCredentialExpiryDeps.readPublic(localPath(path), limit);
			},
		});
		// Then it observes only the same selected public legacy certificate, never its key.
		expect(consumer?.cert).toBe("/etc/apt/certs/client.crt");
		expect(result).toMatchObject({
			kind: "known",
			expiresAt: fixture.expiresAt,
		});
		expect(new Set(reads)).toEqual(new Set(["/etc/apt/certs/client.crt"]));
	},
);
