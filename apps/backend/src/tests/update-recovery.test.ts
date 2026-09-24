import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mayRestartUnit, reconcileStaleUnits, scanStaleUnits } from "../modules/system/update-orchestrator/stale-services.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { getPersistentNotifications, notificationRemove } from "../modules/ui/notifications.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "uso-stale-"));
	roots.push(root);
	return root;
}

describe("stale processes", () => {
	test("never restarts protected service families, including templated units", () => {
		for (const unit of [
			"systemd-journald.service", "dbus.service", "NetworkManager.service",
			"ModemManager.service", "wpa_supplicant@wlan0.service", "rauc.service",
			"pipewire-pulse.service", "wireplumber.service",
		]) expect(mayRestartUnit(unit, false)).toBe(false);
		expect(mayRestartUnit("ssh.service", false)).toBe(true);
		expect(mayRestartUnit("ceralive.service", true)).toBe(false);
	});
	test("detects only deleted system files and resolves exact systemd units", async () => {
		const root = await fixture();
		await mkdir(join(root, "100"));
		await writeFile(join(root, "100/maps"), "7f00-7f01 r-xp 0 00:00 1 /usr/lib/libnm.so (deleted)\n7f02-7f03 r-xp 0 00:00 2 /tmp/a (deleted)\n");
		await writeFile(join(root, "100/cgroup"), "0::/system.slice/NetworkManager.service\n");
		await mkdir(join(root, "101"));
		await writeFile(join(root, "101/maps"), "7f04-7f05 r-xp 0 00:00 3 /usr/lib/libgood.so\n");
		await writeFile(join(root, "101/cgroup"), "0::/system.slice/ssh.service\n");
		expect(await scanStaleUnits(root)).toEqual(["NetworkManager.service"]);
	});

	test("stale NetworkManager is NOT restarted and emits a persistent recommendation", async () => {
		const restarted: string[] = [];
		const root = await fixture();
		await mkdir(join(root, "100"));
		await writeFile(join(root, "100/maps"), "7f00-7f01 r-xp 0 00:00 1 /lib/libnm.so (deleted)\n");
		await writeFile(join(root, "100/cgroup"), "0::/system.slice/NetworkManager.service\n");
		await reconcileStaleUnits({
			procRoot: root,
			isIdle: async () => true,
			transactionRunning: () => false,
			restart: async (unit) => { restarted.push(unit); },
			recommend: (unit) => notifyUpdate({ kind: "restart-recommended", id: unit, unit }),
		});
		expect(restarted).toEqual([]);
		expect(getPersistentNotifications(true).show.some((item) => item.name === "update:restart-recommended:NetworkManager.service")).toBe(true);
		notificationRemove("update:restart-recommended:NetworkManager.service");
	});

	test("self-restart is deferred only during a live transaction", async () => {
		const restarted: string[] = [];
		let running = true;
		const deps = {
			isIdle: async () => true,
			transactionRunning: () => running,
			restart: async (unit: string) => { restarted.push(unit); },
			recommend: () => {},
		};
		await reconcileStaleUnits({ ...deps, units: ["ceralive.service"] });
		expect(restarted).toEqual([]);
		running = false;
		await reconcileStaleUnits({ ...deps, units: ["ceralive.service"] });
		expect(restarted).toEqual(["ceralive.service"]);
	});

	test("eligible stale unit waits for the idle detector", async () => {
		const restarted: string[] = [];
		let idle = false;
		const deps = {
			units: ["ssh.service"],
			isIdle: async () => idle,
			transactionRunning: () => false,
			restart: async (unit: string) => { restarted.push(unit); },
			recommend: () => {},
		};
		expect(await reconcileStaleUnits(deps)).toBe(false);
		expect(restarted).toEqual([]);
		idle = true;
		expect(await reconcileStaleUnits(deps)).toBe(true);
		expect(restarted).toEqual(["ssh.service"]);
	});
});

describe("quarantine", () => {
	test("pins the exact failed package version and lifts only once a newer candidate exists", async () => {
		const root = await fixture();
		const pins: string[] = [];
		const store = new UpdateQuarantine(join(root, "quarantine.json"), async (text) => { pins.push(text); });
		await store.recordPackageFailure([{ name: "cerastream", version: "2026.9.10" }]);
		expect(pins[pins.length - 1]).toContain("Pin: version 2026.9.10\nPin-Priority: -1");
		await store.reconcileCandidates([{ name: "cerastream", version: "2026.9.10" }], async () => false);
		expect(pins[pins.length - 1]).toContain("Pin: version 2026.9.10");
		await store.reconcileCandidates([{ name: "cerastream", version: "2026.9.11" }], async () => true);
		expect(pins[pins.length - 1]).toBe("");
	});

	test("an OS rollback records expected version, not the version actually booted", async () => {
		const root = await fixture();
		const store = new UpdateQuarantine(join(root, "quarantine.json"), async () => {});
		await store.recordOsRollback("2026.10.0", "2026.9.1");
		expect(await store.isOsVersionQuarantined("2026.10.0")).toBe(true);
		expect(await store.isOsVersionQuarantined("2026.9.1")).toBe(false);
	});
});

test("a repeated lifecycle event has a stable ID and sends no duplicate", () => {
	expect(notifyUpdate({ kind: "updates-available", id: "cerastream=2026.9.10" })).toBe(true);
	expect(notifyUpdate({ kind: "updates-available", id: "cerastream=2026.9.10" })).toBe(false);
	notificationRemove("update:updates-available:cerastream=2026.9.10");
});
