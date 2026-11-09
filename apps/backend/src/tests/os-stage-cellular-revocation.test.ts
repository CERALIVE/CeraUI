import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	createSystemCellularConsentRead,
	loadUpdateSettings,
	saveUpdateSettings,
} from "../modules/system/update-settings.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest, ranking } from "./helpers/os-stage-run-inputs.ts";

useSessionOwnerForFile();
const dir = mkdtempSync(join(tmpdir(), "os-dispatch-consent-"));
const file = join(dir, "update-settings.json");
const sidecar = join(dir, "update-image-channel.json");
afterEach(async () => {
	await cleanupRecovery();
	rmSync(file, { force: true });
	rmSync(sidecar, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const boundary of ["revalidate", "consent-read", "proof"] as const) {
	const choices =
		boundary === "revalidate"
			? (["enabled", "revoked", "override", "unreadable"] as const)
			: (["enabled", "revoked", "override"] as const);
	test.each(choices)(
		`metered OS dispatch at ${boundary} honors %s consent`,
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
			let paused = false;
			let consentRead = false;
			const pause = async () => {
				if (paused) return;
				paused = true;
				entered.resolve();
				await resume.promise;
			};
			const h = await harness();
			const stage = runOsStageJob(
				manifest,
				{
					...h.control,
					cellularApproved: true,
					readCellularApproval: async () => {
						const consent = await readConsent();
						consentRead = true;
						if (boundary === "consent-read") await pause();
						return () => choice === "override" || consent();
					},
				},
				{
					...h.deps,
					selection: async () =>
						ranking([h.attempts() === 0 ? "wlan0" : "eth0"], true),
					revalidate: async () => {
						if (boundary === "revalidate") await pause();
					},
					observe: async (...args) => {
						if (consentRead && boundary === "proof") await pause();
						return h.deps.observe(...args);
					},
				},
			).then(
				(value) => value,
				(error: unknown) => error,
			);
			await entered.promise;
			if (choice === "revoked" || choice === "override")
				saveUpdateSettings(
					{ ...selected, allowSystemOverCellular: false },
					file,
				);
			else if (choice === "unreadable") writeFileSync(sidecar, "{damaged");
			resume.resolve();
			const outcome = await stage;

			const allowed = choice === "enabled" || choice === "override";
			expect(h.attempts()).toBe(allowed ? 2 : 0);
			if (allowed) expect(outcome).toBe("receipt");
			else {
				expect(outcome).toBeInstanceOf(OsStageError);
				expect(h.events).not.toContain("prepare-receipt");
				if (choice === "revoked")
					expect(outcome).toHaveProperty(
						"reason",
						"os_cellular_approval_required",
					);
			}
			expect(h.events).toContain("release");
		},
	);
}
