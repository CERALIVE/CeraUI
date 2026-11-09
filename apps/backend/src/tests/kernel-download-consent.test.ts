import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { downloadKernelPackage } from "../modules/system/update-orchestrator/kernel-packages.ts";
import { KernelUpdateError } from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	createSystemCellularConsentRead,
	loadUpdateSettings,
	saveUpdateSettings,
	UpdateSettingsValidationError,
} from "../modules/system/update-settings.ts";
import { kernelRecord } from "./helpers/kernel-update-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "kernel-dispatch-consent-"));
const file = join(dir, "update-settings.json");
const sidecar = join(dir, "update-image-channel.json");
afterEach(() => {
	rmSync(file, { force: true });
	rmSync(sidecar, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const boundary of ["before-read", "after-read"] as const) {
	const choices =
		boundary === "before-read"
			? (["enabled", "revoked", "unreadable"] as const)
			: (["enabled", "revoked"] as const);
	test.each(choices)(
		`kernel network dispatch ${boundary} honors %s consent`,
		async (choice) => {
			const selected = saveUpdateSettings(
				updateSettingsSchema.parse({ allowSystemOverCellular: true }),
				file,
			);
			const readConsent = createSystemCellularConsentRead(() =>
				loadUpdateSettings(file),
			);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await resume.promise;
			};
			const directory = mkdtempSync(join(dir, "download-"));
			const record = {
				...kernelRecord,
				deb_sha256: createHash("sha256").update("ours").digest("hex"),
			};
			let downloads = 0;
			const download = downloadKernelPackage(
				record,
				process.getuid?.() ?? 1000,
				directory,
				{
					signal: new AbortController().signal,
					authorize: async () => {
						if (boundary === "before-read") await pause();
						const consent = await readConsent();
						if (boundary === "after-read") await pause();
						return () => {
							if (!consent())
								throw new KernelUpdateError("os_cellular_approval_required");
						};
					},
				},
				async (argv) => {
					if (argv[0] === "setpriv") {
						downloads++;
						writeFileSync(join(directory, "kernel.deb"), "ours");
					}
					return {
						exitCode: 0,
						stdout:
							argv[0] === "dpkg-deb"
								? `Package: ${record.package}\nVersion: ${record.version}\nArchitecture: arm64\n`
								: "",
						stderr: "",
					};
				},
			).catch((error: unknown) => error);
			await entered.promise;
			if (choice === "revoked")
				saveUpdateSettings(
					{ ...selected, allowSystemOverCellular: false },
					file,
				);
			else if (choice === "unreadable") writeFileSync(sidecar, "{damaged");
			resume.resolve();
			const outcome = await download;

			expect(downloads).toBe(choice === "enabled" ? 1 : 0);
			if (choice === "enabled")
				expect(outcome).toBe(join(directory, "kernel.deb"));
			else if (choice === "revoked")
				expect(outcome).toHaveProperty(
					"reason",
					"os_cellular_approval_required",
				);
			else expect(outcome).toBeInstanceOf(UpdateSettingsValidationError);
		},
	);
}
