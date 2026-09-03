/*
 * SSH boot persistence — the SECOND axis beside start/stop.
 *
 * A shipped bench board was measured `systemctl is-active ssh` = `active` beside
 * `systemctl is-enabled ssh` = `disabled`: SSH worked, looked healthy, and would
 * have vanished on the next reboot with nothing on any surface saying so. CeraUI
 * only ever ran `start`/`stop`, so an operator could not commit SSH to boot at
 * all, and could not see that it was not committed.
 *
 * What this suite pins is the SEPARATION, in both directions — the two axes share
 * a unit and must never share a verb:
 *
 *   - `setSshPersistent` runs `enable`/`disable` and provably NEVER `start`/`stop`;
 *   - `startStopSsh` runs `start`/`stop` and provably NEVER `enable`/`disable`;
 *   - `--now` (which would fuse them back together) appears nowhere in the module.
 *
 * The seam spies prove which VERB fired; the source gate proves the ARGV the
 * default runner builds, which no seam can observe because the seam is what
 * replaces it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";

import { initMockService, shouldUseMocks } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import {
	getSshStatus,
	parseSystemctlIsEnabled,
	resetMockSshState,
	resetSshPersistenceRunner,
	resetSshServiceRunner,
	type SshStatusDeps,
	setSshPersistenceRunner,
	setSshPersistent,
	setSshServiceRunner,
	startStopSsh,
} from "../modules/system/ssh.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const SHADOW = "produser:$6$abc$hashvalue:19000:0:99999:7:::\n";

function stubWs(): WebSocket {
	return { send: () => {} } as unknown as WebSocket;
}

/** Deterministic status deps so no probe ever reaches a real systemctl. */
function statusDeps(
	over: { active?: boolean; enabled?: boolean } = {},
): Partial<SshStatusDeps> {
	return {
		systemctlIsActive: async () => ({
			stdout: over.active === false ? "inactive" : "active",
			stderr: "",
		}),
		systemctlIsEnabled: async () => ({
			stdout: over.enabled ? "enabled" : "disabled",
			stderr: "",
		}),
		readShadow: () => SHADOW,
		broadcast: () => {},
	};
}

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedDeviceType: string | undefined;
let savedSshUser: string | undefined;
let savedSshPass: string | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
	savedSshUser = setup.ssh_user;
	savedSshPass = getConfig().ssh_pass;
	resetMockSshState();
});

afterEach(() => {
	resetSshPersistenceRunner();
	resetSshServiceRunner();
	resetMockSshState();

	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("NODE_ENV", savedNodeEnv);
	restore("MOCK_MODE", savedMockMode);
	restore("CERALIVE_DEVICE_TYPE", savedDeviceType);
	setup.ssh_user = savedSshUser;
	getConfig().ssh_pass = savedSshPass;
});

/** Production mode: the real runner seams fire, the mock branch is skipped. */
function enterProd(): void {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	setup.ssh_user = "produser";
	getConfig().ssh_pass = "preset";
}

// ── the verb, and only the verb ──────────────────────────────────────────────

describe("setSshPersistent — the enable/disable verb", () => {
	test("enabling runs `enable` and NEVER start/stop", async () => {
		enterProd();
		const persistence: string[] = [];
		const service: string[] = [];
		setSshPersistenceRunner(async (a) => {
			persistence.push(a);
		});
		setSshServiceRunner(async (a) => {
			service.push(a);
		});

		const ok = await setSshPersistent(true, statusDeps({ enabled: true }));

		expect(ok).toBe(true);
		expect(persistence).toEqual(["enable"]);
		expect(service).toEqual([]);
	});

	test("disabling runs `disable` and NEVER start/stop", async () => {
		enterProd();
		const persistence: string[] = [];
		const service: string[] = [];
		setSshPersistenceRunner(async (a) => {
			persistence.push(a);
		});
		setSshServiceRunner(async (a) => {
			service.push(a);
		});

		const ok = await setSshPersistent(false, statusDeps({ enabled: false }));

		expect(ok).toBe(true);
		expect(persistence).toEqual(["disable"]);
		expect(service).toEqual([]);
	});

	test("a refused systemctl reports failure rather than a silent success", async () => {
		enterProd();
		setSshPersistenceRunner(async () => {
			throw new Error("systemctl failed");
		});

		expect(await setSshPersistent(true, statusDeps({ enabled: false }))).toBe(
			false,
		);
	});

	test("the device's own re-probe decides — an unchanged unit is NOT success", async () => {
		enterProd();
		setSshPersistenceRunner(async () => {});

		// The runner resolved, but the unit still reports `disabled`: the request
		// did not take, so the caller must not be told it did.
		expect(await setSshPersistent(true, statusDeps({ enabled: false }))).toBe(
			false,
		);
	});

	test("(dev) flips the mock flag with NO systemctl spawn", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		initMockService("multi-modem-wifi");
		expect(shouldUseMocks()).toBe(true);

		const persistence: string[] = [];
		setSshPersistenceRunner(async (a) => {
			persistence.push(a);
		});

		expect(await setSshPersistent(true)).toBe(true);
		expect(persistence).toEqual([]);
	});
});

// ── the two axes never move each other ───────────────────────────────────────

describe("the running state and the boot state are independent", () => {
	test("a persistence change leaves `active` alone", async () => {
		enterProd();
		setSshPersistenceRunner(async () => {});

		// The unit is running throughout; only `enabled` moves.
		await setSshPersistent(true, statusDeps({ active: true, enabled: false }));
		const before = await getSshStatus(
			statusDeps({ active: true, enabled: false }),
		);
		expect(before?.active).toBe(true);
		expect(before?.enabled).toBe(false);

		await setSshPersistent(true, statusDeps({ active: true, enabled: true }));
		const after = await getSshStatus(
			statusDeps({ active: true, enabled: true }),
		);
		expect(after?.active).toBe(true);
		expect(after?.enabled).toBe(true);
	});

	test("startStopSsh NEVER runs enable/disable, in either direction", async () => {
		enterProd();
		const persistence: string[] = [];
		const service: string[] = [];
		setSshPersistenceRunner(async (a) => {
			persistence.push(a);
		});
		setSshServiceRunner(async (a) => {
			service.push(a);
		});

		await startStopSsh(stubWs(), "start_ssh", statusDeps({ active: true }));
		await startStopSsh(
			stubWs(),
			"stop_ssh",
			statusDeps({ active: false, enabled: true }),
		);

		expect(service).toEqual(["start", "stop"]);
		expect(persistence).toEqual([]);
	});

	test("stopping the service does NOT clear the boot arming", async () => {
		enterProd();
		setSshServiceRunner(async () => {});

		await startStopSsh(
			stubWs(),
			"stop_ssh",
			statusDeps({ active: false, enabled: true }),
		);
		const status = await getSshStatus(
			statusDeps({ active: false, enabled: true }),
		);

		expect(status?.active).toBe(false);
		expect(status?.enabled).toBe(true);
	});
});

// ── the is-enabled reading ───────────────────────────────────────────────────

describe("parseSystemctlIsEnabled", () => {
	test("only the exact word `enabled` is persistence", () => {
		expect(parseSystemctlIsEnabled("enabled")).toBe(true);
		expect(parseSystemctlIsEnabled("enabled\n")).toBe(true);
		expect(parseSystemctlIsEnabled("  enabled  ")).toBe(true);
	});

	test("`enabled-runtime` is NOT persistence — its symlink lives in /run", () => {
		expect(parseSystemctlIsEnabled("enabled-runtime\n")).toBe(false);
	});

	test("every other systemd verdict reads as not-persistent", () => {
		for (const word of [
			"disabled",
			"static",
			"indirect",
			"generated",
			"masked",
			"linked",
			"alias",
			"transient",
			"",
			"   ",
		]) {
			expect(parseSystemctlIsEnabled(`${word}\n`)).toBe(false);
		}
	});
});

describe("getSshStatus — the enabled probe", () => {
	test("publishes `enabled` EXPLICITLY, in both directions", async () => {
		enterProd();

		const on = await getSshStatus(statusDeps({ enabled: true }));
		expect(on?.enabled).toBe(true);
		expect(Object.hasOwn(on ?? {}, "enabled")).toBe(true);

		resetMockSshState();
		const off = await getSshStatus(statusDeps({ enabled: false }));
		// Never omitted-when-false: a consumer merge preserves an absent optional,
		// so a present-only-when-true flag could be raised and never lowered.
		expect(off?.enabled).toBe(false);
		expect(Object.hasOwn(off ?? {}, "enabled")).toBe(true);
	});

	test("swallows the non-zero exit and reads the word off stdout", async () => {
		enterProd();

		// `systemctl is-enabled` exits 1 for a disabled unit and still prints it.
		const status = await getSshStatus({
			...statusDeps(),
			systemctlIsEnabled: async () => {
				throw Object.assign(new Error("exit 1"), { stdout: "disabled\n" });
			},
		});

		expect(status?.enabled).toBe(false);
	});

	test("an unreadable probe is not-persistent, never a throw", async () => {
		enterProd();

		const status = await getSshStatus({
			...statusDeps({ active: true }),
			systemctlIsEnabled: async () => {
				throw new Error("systemctl: command not found");
			},
		});

		expect(status?.enabled).toBe(false);
		expect(status?.active).toBe(true);
	});

	test("a change in `enabled` ALONE re-broadcasts", async () => {
		enterProd();
		const seen: boolean[] = [];
		const broadcast = (s: { enabled: boolean }) => {
			seen.push(s.enabled);
		};

		await getSshStatus({ ...statusDeps({ enabled: false }), broadcast });
		// Same user, same active, same password state — only the boot arming moved.
		await getSshStatus({ ...statusDeps({ enabled: true }), broadcast });
		// A repeat of the second reading must NOT re-broadcast.
		await getSshStatus({ ...statusDeps({ enabled: true }), broadcast });

		expect(seen).toEqual([false, true]);
	});
});

// ── the argv the seam replaces ───────────────────────────────────────────────

describe("the shipped argv carries no `--now`", () => {
	const SOURCE = join(import.meta.dir, "..", "modules", "system", "ssh.ts");

	/** Executable lines only, so this file's own prose may name `--now`. */
	function code(): string {
		return readFileSync(SOURCE, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.split("\n")
			.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
			.join("\n");
	}

	test("the gate reads a non-trivial module (empty extraction FAILS)", () => {
		expect(code()).toContain("setSshPersistent");
		expect(code().length).toBeGreaterThan(2000);
	});

	test("the persistence runner spawns exactly `systemctl <action> ssh`", () => {
		expect(code()).toContain('await execFileP("systemctl", [action, "ssh"]);');
	});

	test("`--now` appears in NO executable line", () => {
		// Fusing the axes back together is a one-word edit away, and it is invisible
		// to every seam spy above: `enable --now` would silently start sshd, and
		// `disable --now` would kill the operator's live session.
		expect(code()).not.toContain("--now");
	});
});
