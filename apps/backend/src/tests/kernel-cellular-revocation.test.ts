import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import {
	createKernelRuntime,
	defaultKernelEffects,
	type KernelEffects,
} from "../modules/system/update-orchestrator/kernel-runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	loadUpdateSettings,
	saveUpdateSettings,
} from "../modules/system/update-settings.ts";
import {
	kernelCapabilities,
	kernelRecord,
} from "./helpers/kernel-update-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "kernel-consent-revocation-"));
const file = join(dir, "update-settings.json");
const sidecar = join(dir, "update-image-channel.json");
afterEach(() => {
	rmSync(file, { force: true });
	rmSync(sidecar, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const boundary of [
	"idle",
	"healthy",
	"download",
	"consent-read",
] as const) {
	test.each([
		"enabled",
		"revoked",
		"unreadable",
		"override",
		"other-candidate",
	] as const)(
		`automatic kernel download at ${boundary} honors %s consent`,
		async (choice) => {
			const selected = saveUpdateSettings(
				updateSettingsSchema.parse({ allowSystemOverCellular: true }),
				file,
			);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await resume.promise;
			};
			let state: OrchestratorState = initialOrchestratorState(0);
			if (choice === "override")
				state = { ...state, cellularOverrideId: kernelRecord.version };
			else if (choice === "other-candidate")
				state = { ...state, cellularOverrideId: `${kernelRecord.version}-old` };
			let downloads = 0;
			let launches = 0;
			let reads = 0;
			const notices: string[] = [];
			const effects: KernelEffects = {
				...defaultKernelEffects,
				discover: async () => kernelRecord,
				readState: async () => null,
				ensureHealthyState: async () => {
					if (boundary === "healthy") await pause();
				},
				download: async (_record, _signal, authorize) => {
					if (boundary === "download") await pause();
					(await authorize())();
					downloads++;
					return "/fixture/kernel.deb";
				},
				launch: async () => {
					launches++;
				},
				notify: (notice: Parameters<typeof defaultKernelEffects.notify>[0]) => {
					notices.push(notice.kind);
					return true;
				},
			};
			const lane = createKernelRuntime({
				effects: () => effects,
				state: () => state,
				set: (patch) => {
					state = { ...state, ...patch };
				},
				now: () => 1000,
				capabilities: async () => kernelCapabilities,
				settings: async () => {
					const loaded = await loadUpdateSettings(file);
					if (++reads === 2 && boundary === "consent-read") await pause();
					return loaded;
				},
				idle: async () => {
					if (boundary === "idle") await pause();
					return true;
				},
				metered: async () => true,
				busy: () => false,
				bootedSlot: async () => "A",
				activate: async () => false,
			});
			await lane.check();
			const install = lane.install(false);
			await entered.promise;
			if (
				choice === "revoked" ||
				choice === "override" ||
				choice === "other-candidate"
			)
				saveUpdateSettings(
					{ ...selected, allowSystemOverCellular: false },
					file,
				);
			else if (choice === "unreadable") writeFileSync(sidecar, "{damaged");
			resume.resolve();

			const allowed = choice === "enabled" || choice === "override";
			expect(await install).toBe(allowed);
			expect(downloads).toBe(allowed ? 1 : 0);
			expect(launches).toBe(allowed ? 1 : 0);
			if (choice === "revoked" || choice === "other-candidate") {
				expect(state.phase).toBe("idle");
				expect(notices).toEqual(["cellular-approval"]);
			}
			if (allowed) expect(state.cellularOverrideId).toBeNull();
		},
	);
}
