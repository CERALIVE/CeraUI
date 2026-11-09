import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import {
	decideCellularGate,
	systemCellularApproved,
} from "../modules/system/update-orchestrator/schedule.ts";
import {
	loadUpdateSettings,
	saveUpdateSettings,
} from "../modules/system/update-settings.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-update-consent-"));
const file = join(dir, "update-settings.json");
const sidecar = join(dir, "update-image-channel.json");
// v2026.11.1 saves only these six keys; it never reads or writes the sidecar.
const legacy = {
	packagesAuto: false,
	systemAuto: true,
	schedule: { mode: "window", start: "22:30", end: "04:00" },
	channel: "beta",
	allowPackagesOverCellular: false,
	allowSystemOverCellular: true,
} as const;
const meteredInstall = {
	onlyMeteredCandidateExists: true,
	kind: "os",
	stage: "install",
	allowPackagesOverCellular: false,
	cellularOverrideId: null,
	candidateId: "2026.11.2",
} as const;

afterEach(() => {
	rmSync(file, { force: true });
	rmSync(sidecar, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.each(["absent", "channel-only"] as const)(
	"%s sidecar never promotes legacy check permission to OS/kernel download consent",
	async (authority) => {
		writeFileSync(file, JSON.stringify(legacy));
		if (authority === "channel-only") {
			writeFileSync(sidecar, JSON.stringify({ schema: 1, channel: "stable" }));
		}

		const loaded = await loadUpdateSettings(file);

		expect(loaded).toEqual({
			...legacy,
			channel: authority === "channel-only" ? "stable" : "beta",
			allowSystemOverCellular: false,
		});
		expect(
			decideCellularGate({ ...meteredInstall, ...loaded, stage: "check" }),
		).toEqual({ allowed: true });
		expect(decideCellularGate({ ...meteredInstall, ...loaded })).toEqual({
			allowed: false,
			needsOverride: true,
		});
		expect(systemCellularApproved({ ...meteredInstall, ...loaded })).toBe(
			false,
		);
		expect(
			decideCellularGate({
				...meteredInstall,
				...loaded,
				cellularOverrideId: meteredInstall.candidateId,
			}),
		).toEqual({ allowed: true });
		// An unrelated UI save round-trips the fresh public value, not legacy true.
		saveUpdateSettings({ ...loaded, packagesAuto: true }, file);
		expect((await loadUpdateSettings(file)).allowSystemOverCellular).toBe(
			false,
		);
	},
);

test.each([false, true])(
	"explicit download consent survives restart and rollback with old check permission %s",
	async (oldCheckPermission) => {
		const selected = updateSettingsSchema.parse({
			...legacy,
			channel: "stable",
		});
		saveUpdateSettings(selected, file);
		expect(await loadUpdateSettings(file)).toEqual(selected);
		const consentBytes = readFileSync(sidecar, "utf8");
		// The old writer changes ordinary settings without changing download consent.
		const rolledBack = {
			...legacy,
			packagesAuto: true,
			systemAuto: false,
			schedule: { mode: "any-idle", start: "01:00", end: "02:00" },
			allowPackagesOverCellular: true,
			allowSystemOverCellular: oldCheckPermission,
		} as const;
		writeFileSync(file, JSON.stringify(rolledBack));

		const loaded = await loadUpdateSettings(file);

		expect(loaded).toEqual({
			...rolledBack,
			channel: "stable",
			allowSystemOverCellular: true,
		});
		expect(await loadUpdateSettings(file)).toEqual(loaded);
		expect(decideCellularGate({ ...meteredInstall, ...loaded })).toEqual({
			allowed: true,
		});
		expect(systemCellularApproved({ ...meteredInstall, ...loaded })).toBe(true);
		expect(readFileSync(sidecar, "utf8")).toBe(consentBytes);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rolledBack);
	},
);

test("revoked download consent cannot be restored by the old check-only writer", async () => {
	const selected = saveUpdateSettings(updateSettingsSchema.parse(legacy), file);
	saveUpdateSettings({ ...selected, allowSystemOverCellular: false }, file);
	writeFileSync(file, JSON.stringify(legacy));

	const loaded = await loadUpdateSettings(file);

	expect(loaded.allowSystemOverCellular).toBe(false);
	expect(decideCellularGate({ ...meteredInstall, ...loaded })).toEqual({
		allowed: false,
		needsOverride: true,
	});
});

test("lost sidecar requires fresh consent even after an explicit download approval", async () => {
	saveUpdateSettings(updateSettingsSchema.parse(legacy), file);
	rmSync(sidecar);

	const loaded = await loadUpdateSettings(file);

	expect(loaded).toEqual({ ...legacy, allowSystemOverCellular: false });
	expect(decideCellularGate({ ...meteredInstall, ...loaded })).toEqual({
		allowed: false,
		needsOverride: true,
	});
});

test.each([false, true])(
	"sidecar consent %s remains authoritative when the six-key file is absent",
	async (consent) => {
		saveUpdateSettings(
			updateSettingsSchema.parse({
				channel: "stable",
				allowSystemOverCellular: consent,
			}),
			file,
		);
		rmSync(file);

		expect(await loadUpdateSettings(file)).toEqual({
			...updateSettingsSchema.parse({}),
			channel: "stable",
			allowSystemOverCellular: consent,
		});
	},
);
