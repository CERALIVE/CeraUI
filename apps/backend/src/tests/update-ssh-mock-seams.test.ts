/*
 * T8 — dev-parity for software-update progress + the SSH toggle.
 *
 * On a dev box neither subsystem may shell out: an `apt-get dist-upgrade` would
 * mutate the developer's machine and a `systemctl start ssh` would flip a real
 * service. Under shouldUseMocks() both ops are emulated — the update broadcasts
 * an incrementing progress→complete sequence and the SSH toggle flips a mock
 * active flag and broadcasts it — with NO child process spawned.
 *
 * Each real OS command is injected through a runner seam (mirrors T1's
 * setPowerCommandRunner / setRebootRunner), so the suite asserts on whether the
 * runner FIRED rather than ever spawning apt / systemctl:
 *
 *   - (dev)  the injected runner is asserted NOT called, yet progress / ssh
 *            frames are still broadcast.
 *   - (prod) NODE_ENV=production drops the mock gate, so the injected runner IS
 *            called — proving the real spawn path is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";

import { initMockService, shouldUseMocks } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import {
	getMockSoftwareUpdatePromise,
	isUpdating,
	resetSoftwareUpdateRunner,
	setSoftwareUpdateRunner,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	resetMockSshState,
	resetSshServiceRunner,
	type SshStatusDeps,
	setSshServiceRunner,
	startStopSsh,
} from "../modules/system/ssh.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

// ── broadcast capture (mirrors dev-capability-profile.test.ts) ───────────────

function makeClient(sent: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: 0 },
		send: (msg: string) => {
			sent.push(msg);
		},
	} as unknown as AppWebSocket;
}

type UpdatingFrame = {
	total: number;
	downloading: number;
	unpacking: number;
	setting_up: number;
	result?: string | number;
};
type SshFrame = { user?: string; active?: boolean; user_pass?: boolean };
type StatusEnvelope = {
	status?: { updating?: UpdatingFrame; ssh?: SshFrame };
};

function statusFrames(sent: string[]): StatusEnvelope[] {
	return sent
		.map((s) => JSON.parse(s) as StatusEnvelope)
		.filter((m) => m.status != null);
}

function updatingFrames(sent: string[]): UpdatingFrame[] {
	return statusFrames(sent)
		.map((m) => m.status?.updating)
		.filter((u): u is UpdatingFrame => u != null);
}

function sshFrames(sent: string[]): SshFrame[] {
	return statusFrames(sent)
		.map((m) => m.status?.ssh)
		.filter((u): u is SshFrame => u != null);
}

function stubWs(): WebSocket {
	return { send: () => {} } as unknown as WebSocket;
}

// ── env + module-global snapshot/restore ─────────────────────────────────────

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedDeviceType: string | undefined;
let savedSshUser: string | undefined;
let savedAptEnabled: boolean | undefined;
let savedSshPass: string | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
	savedSshUser = setup.ssh_user;
	savedAptEnabled = setup.apt_update_enabled;
	savedSshPass = getConfig().ssh_pass;
});

afterEach(() => {
	resetSoftwareUpdateRunner();
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
	setup.apt_update_enabled = savedAptEnabled;
	getConfig().ssh_pass = savedSshPass;
});

/** Enter dev mock mode: development env + an initialised mock service. */
function enterDevMock(): void {
	process.env.NODE_ENV = "development";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	initMockService("multi-modem-wifi");
}

// ── software update ──────────────────────────────────────────────────────────

describe("software update — dev mock seam", () => {
	test("(dev) startSoftwareUpdate broadcasts progress→complete with NO apt spawn", async () => {
		enterDevMock();
		setup.apt_update_enabled = true;
		expect(shouldUseMocks()).toBe(true);

		let runnerCalls = 0;
		setSoftwareUpdateRunner(() => {
			runnerCalls++;
		});

		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			startSoftwareUpdate();
			await getMockSoftwareUpdatePromise();
		} finally {
			removeClient(client);
		}

		// The real apt path (checkForSoftwareUpdates → doSoftwareUpdate) NEVER ran.
		expect(runnerCalls).toBe(0);

		const frames = updatingFrames(sent);
		// A start frame + several progress frames + a completion frame.
		expect(frames.length).toBeGreaterThanOrEqual(3);

		// Progress (downloading + unpacking + setting_up) never goes backwards.
		const progress = frames.map(
			(f) => f.downloading + f.unpacking + f.setting_up,
		);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] ?? 0);
		}
		// It actually advanced past the initial zero frame.
		expect(progress.at(-1) ?? 0).toBeGreaterThan(0);

		// The sequence ends in a successful completion (result === 0)...
		const completion = frames.find((f) => f.result === 0);
		expect(completion).toBeDefined();
		// ...and the update is no longer in progress.
		expect(isUpdating()).toBe(false);
	});
});

describe("software update — production proof", () => {
	test("(prod) startSoftwareUpdate invokes the real apt runner exactly once", () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		setup.apt_update_enabled = true;
		expect(shouldUseMocks()).toBe(false);

		let runnerCalls = 0;
		setSoftwareUpdateRunner(() => {
			runnerCalls++;
		});

		startSoftwareUpdate();

		// The real apt spawn path fires unconditionally in production.
		expect(runnerCalls).toBe(1);
	});
});

// ── SSH toggle ───────────────────────────────────────────────────────────────

describe("SSH toggle — dev mock seam", () => {
	test("(dev) startStopSsh flips SSH active with NO systemctl spawn", async () => {
		enterDevMock();
		setup.ssh_user = "devuser";
		getConfig().ssh_pass = "preset";
		expect(shouldUseMocks()).toBe(true);

		const runnerActions: string[] = [];
		setSshServiceRunner(async (action) => {
			runnerActions.push(action);
		});

		// start_ssh → active true
		const sentStart: string[] = [];
		const clientStart = makeClient(sentStart);
		addClient(clientStart);
		try {
			await startStopSsh(stubWs(), "start_ssh");
		} finally {
			removeClient(clientStart);
		}
		expect(runnerActions).toHaveLength(0); // systemctl never spawned
		expect(sshFrames(sentStart).at(-1)?.active).toBe(true);

		// stop_ssh → active false, still no spawn
		const sentStop: string[] = [];
		const clientStop = makeClient(sentStop);
		addClient(clientStop);
		try {
			await startStopSsh(stubWs(), "stop_ssh");
		} finally {
			removeClient(clientStop);
		}
		expect(runnerActions).toHaveLength(0);
		expect(sshFrames(sentStop).at(-1)?.active).toBe(false);
	});
});

describe("SSH toggle — production proof", () => {
	test("(prod) startStopSsh invokes the real systemctl runner", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		setup.ssh_user = "produser";
		// Pre-seed ssh_pass so the start path skips resetSshPassword (passwd spawn).
		getConfig().ssh_pass = "preset";
		expect(shouldUseMocks()).toBe(false);

		const runnerActions: string[] = [];
		setSshServiceRunner(async (action) => {
			runnerActions.push(action);
		});

		// Inject deterministic status deps so the post-toggle getSshStatus refresh
		// never spawns systemctl / reads the real /etc/shadow.
		const statusDeps: Partial<SshStatusDeps> = {
			systemctlIsActive: async () => ({ stdout: "active", stderr: "" }),
			readShadow: () => "produser:$6$abc$hashvalue:19000:0:99999:7:::\n",
			broadcast: () => {},
		};

		await startStopSsh(stubWs(), "start_ssh", statusDeps);

		// The real systemctl runner fired with the start action.
		expect(runnerActions).toEqual(["start"]);
	});

	test("(prod) reports failure when the SSH service action fails", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "preset";
		setSshServiceRunner(async () => {
			throw new Error("systemctl failed");
		});

		const success = await startStopSsh(stubWs(), "start_ssh", {
			systemctlIsActive: async () => ({ stdout: "inactive", stderr: "" }),
			readShadow: () => "produser:$6$abc$hashvalue:19000:0:99999:7:::\n",
			broadcast: () => {},
		});

		expect(success).toBe(false);
	});
});
