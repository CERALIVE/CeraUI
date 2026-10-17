import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCritical } from "../helpers/boot-guard.ts";
import {
	getConfig,
	isRuntimeConfigAvailable,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	awaitRuntimeConfig,
	bootRuntimeConfig,
	defaultRuntimeConfigBootDeps,
	stopRuntimeConfigRecovery,
} from "../modules/config-boot.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";

// A cost-4 bcrypt digest of "correct-password"; shape is all the boot step checks.
const HASH = "$2b$04$C6UzMDM.H6dfI/f/IKxGhuRk2bVv8OkCmJrE2BMjX1MSUb4ki3PLW";
const MAIN = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

let root: string;
let path: string;
let sleeps: number[];
let damagedCopies: string[];
let release: (() => void) | undefined;

const deps = {
	sleep: (ms: number) => {
		sleeps.push(ms);
		// The two pre-bind attempts pass at once; the background owner waits.
		if (sleeps.length <= 2) return Promise.resolve();
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	},
	onDamagedReset: (copy: string) => {
		damagedCopies.push(copy);
	},
};

function copiesIn(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.includes(".damaged-"));
}

async function firstRunConfig(): Promise<unknown> {
	setConfigFilePath(join(root, "absent", "config.json"));
	await loadConfig();
	const snapshot = structuredClone(getConfig());
	setConfigFilePath(path);
	return snapshot;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "config-boot-"));
	path = join(root, "config.json");
	setConfigFilePath(path);
	sleeps = [];
	damagedCopies = [];
	release = undefined;
});

afterEach(async () => {
	stopRuntimeConfigRecovery();
	setPasswordHash(undefined);
	release?.();
	notificationRemove("config_damaged_reset");
	rmSync(path, { recursive: true, force: true });
	writeFileSync(path, "{}");
	await loadConfig();
	setConfigFilePath("config.json");
	rmSync(root, { recursive: true, force: true });
});

test.each(["", '{"autostart":', '{"autostart":"bad","max_br":9000}'])(
	"damaged config %p still reaches the control bind with first-run settings",
	async (bytes) => {
		// Given the first-run state and a config left damaged by interrupted storage.
		const expected = await firstRunConfig();
		writeFileSync(path, bytes);
		let bound = false;
		// When the production boot-config step precedes the control bind.
		await runCritical("config", async () => {
			await bootRuntimeConfig(deps);
		});
		bound = true;
		// Then the bind is reached, the bytes are archived and first-run is exact.
		expect(bound).toBe(true);
		expect(getConfig()).toEqual(expected as never);
		expect(getConfig().autostart).toBe(false);
		const copies = copiesIn(root);
		expect(copies).toHaveLength(1);
		expect(readFileSync(join(root, copies[0] ?? "-"), "utf8")).toBe(bytes);
		expect(damagedCopies).toEqual([join(root, copies[0] ?? "-")]);
		expect(readFileSync(path, "utf8")).toBe("{}");
		expect(sleeps).toEqual([]);
	},
);

test("a damaged config keeps a well-formed password and never re-archives", async () => {
	// Given a wrong-type safety field beside a valid password, and an older copy.
	writeFileSync(join(root, "config.json.damaged-earlier"), "older");
	writeFileSync(path, `{"autostart":"bad","password_hash":"${HASH}"}`);
	// When boot resets it twice in a row (the second boot finds a clean file).
	await bootRuntimeConfig(deps);
	await bootRuntimeConfig(deps);
	// Then access is no wider than before and the earlier copy is untouched.
	expect(getPasswordHash()).toBe(HASH);
	expect(readFileSync(join(root, "config.json.damaged-earlier"), "utf8")).toBe(
		"older",
	);
	expect(copiesIn(root)).toHaveLength(2);
	expect(getConfig().autostart).toBe(false);
});

test("the default damaged-config notice names the archived copy", async () => {
	// Given a zero-byte config.
	writeFileSync(path, "");
	// When the shipped boot dependencies handle it.
	await bootRuntimeConfig(defaultRuntimeConfigBootDeps);
	// Then a persistent, keyed notice tells the operator where the copy is.
	const copy = copiesIn(root)[0];
	const shown = getPersistentNotifications(true).show.filter(
		(n) => n.name === "config_damaged_reset",
	);
	expect(shown).toHaveLength(1);
	expect(shown[0]?.key).toBe("notifications.configDamagedReset");
	expect(shown[0]?.params).toEqual({ copy });
	expect(shown[0]?.type).toBe("error");
});

test("an unreadable config binds unavailable, then the owner loads the repair", async () => {
	// Given an entry that cannot be read as a regular file (an I/O-class failure).
	mkdirSync(path);
	// When boot exhausts its bounded attempts.
	const outcome = await bootRuntimeConfig(deps);
	// Then the bind may proceed while authority stays withheld and nothing is written.
	expect(outcome).toBe("unavailable");
	expect(isRuntimeConfigAvailable()).toBe(false);
	expect(() => getConfig()).toThrow();
	expect(() => saveConfig()).toThrow();
	expect(readdirSync(path)).toEqual([]);
	expect(sleeps).toEqual([250, 1000, 1000]);
	// When storage is repaired and the owner's next attempt runs.
	rmSync(path, { recursive: true });
	writeFileSync(path, '{"max_br":4000}');
	release?.();
	await awaitRuntimeConfig();
	// Then the latch clears from the repaired file without any archive.
	expect(isRuntimeConfigAvailable()).toBe(true);
	expect(getConfig().max_br).toBe(4000);
	expect(copiesIn(root)).toEqual([]);
});

test("the owner backs off with a ceiling while the file stays unreadable", async () => {
	// Given a persistently unreadable entry and a clock that releases every wait.
	mkdirSync(path);
	const waits: number[] = [];
	let twelfth: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		twelfth = resolve;
	});
	const counting = {
		...deps,
		sleep: (ms: number) => {
			waits.push(ms);
			if (waits.length === 12) {
				stopRuntimeConfigRecovery();
				twelfth();
			}
			return Promise.resolve();
		},
	};
	// When boot hands it to the background owner and it waits twelve times.
	await bootRuntimeConfig(counting);
	await reached;
	// Then the delays double to a 60 s ceiling and the stop ends the owner.
	expect(waits).toEqual([
		250, 1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000,
	]);
	expect(isRuntimeConfigAvailable()).toBe(false);
});

test("main binds the control server before it waits for an unavailable config", () => {
	// Given the shipped boot ladder (behaviour inside top-level await is not observable).
	const code = MAIN.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
	const boot = code.indexOf("await bootRuntimeConfig()");
	const bind = code.indexOf(
		'await runCritical("ws-control-server", initServer)',
	);
	const wait = code.indexOf("await awaitRuntimeConfig()");
	// Then the load cannot abort boot and the wait follows the bind.
	expect(code).not.toContain('runCritical("config", loadConfig)');
	expect(boot).toBeGreaterThan(-1);
	expect(boot).toBeLessThan(bind);
	expect(bind).toBeLessThan(wait);
	expect(wait).toBeLessThan(code.indexOf("await guardNonCritical("));
});

async function firstRunClaim(): Promise<{
	prompted: boolean;
	claimed: boolean;
}> {
	const { createWebSocketHandler } = await import("../rpc/adapter.ts");
	const { removeClient } = await import("../rpc/events.ts");
	const { setPasswordProcedure } = await import(
		"../rpc/procedures/auth.procedure.ts"
	);
	const { call } = await import("@orpc/server");
	const { createContext } = await import("../rpc/context.ts");
	const frames: string[] = [];
	// Transport double: an unauthenticated browser; no listener is opened.
	const ws = {
		data: { isAuthenticated: false, lastActive: Date.now() },
		remoteAddress: "test",
		send: (frame: string) => {
			frames.push(frame);
		},
		close: () => {},
	} as never;
	createWebSocketHandler().open?.(ws);
	removeClient(ws);
	await call(
		setPasswordProcedure,
		{ password: "attacker-password" },
		{ context: createContext(ws) },
	).catch(() => undefined);
	return {
		prompted: frames.some((frame) => frame.includes("set_password")),
		claimed: getPasswordHash() !== undefined,
	};
}

test("an unreadable config offers no first-run password claim", async () => {
	// Given a device whose stored password is unknown because config is unreadable.
	setPasswordHash(undefined);
	mkdirSync(path);
	await bootRuntimeConfig(deps);
	// When an unauthenticated browser connects and tries to set a password.
	const result = await firstRunClaim();
	// Then it is neither prompted nor able to install its own password.
	expect(result).toEqual({ prompted: false, claimed: false });
});

test("a readable config without a password still offers first-run setup", async () => {
	// Given a genuinely absent config, as on a first boot.
	setPasswordHash(undefined);
	await bootRuntimeConfig(deps);
	// When an unauthenticated browser connects and sets a password.
	const result = await firstRunClaim();
	// Then first-run setup works exactly as before.
	expect(result).toEqual({ prompted: true, claimed: true });
});
