import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Per-worker mock-backend lifecycle for the Playwright e2e suite.
 *
 * Each Playwright worker spawns its OWN backend on a unique port with its OWN
 * working directory, so the backend's CWD-relative state files (`config.json`,
 * `auth_tokens.json`, `setup.json` — see apps/backend AGENTS.md "Config files …
 * read/written from working dir") are isolated per worker. This removes both
 * shared-`config.json` clobbering AND `dev.emit` broadcast bleed across workers,
 * which is what previously forced `workers: 2` and the broad `serial` cordon.
 *
 * The shared Vite dev server (port 6173) still serves every worker's frontend —
 * it is stateless. The browser is routed to this worker's backend via the
 * dev-only `window.__ceraSocketPort` seam (see src/lib/env/index.ts), injected
 * by the page fixture before the app boots.
 */

const BACKEND_DIR = path.resolve(import.meta.dirname, "../../../../backend");
const BACKEND_ENTRY = path.join(BACKEND_DIR, "src/main.ts");

/** Mutable CWD-relative state files; plain-copied so each worker owns its own. */
const STATE_FILES = ["config.json", "auth_tokens.json"] as const;

/** First per-worker port. Clears Vite (6173) and the reference backend (3002). */
const BASE_PORT = 3100;
const READY_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 200;
const STOP_GRACE_MS = 4_000;

/** Must match the bcrypt cost the backend uses (auth.procedure.ts BCRYPT_ROUNDS). */
const BCRYPT_COST = 10;
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "12345678";

let cachedPasswordHash: string | undefined;

/**
 * A fresh worker backend reads config.json from disk; token AND password login
 * both short-circuit unless a password hash is set in memory (auth.procedure.ts
 * `if (!passwordHash) return { success: false }`). globalSetup seeds the auth
 * TOKENS but does not reliably persist the hash to the copied config.json, so we
 * inject a bcrypt hash of the e2e password (computed via Bun — Node has no
 * bcrypt) so every worker backend authenticates exactly like the live one.
 */
function passwordHash(): string {
	if (cachedPasswordHash === undefined) {
		cachedPasswordHash = execFileSync(
			"bun",
			[
				"-e",
				`process.stdout.write(Bun.password.hashSync(${JSON.stringify(
					E2E_PASSWORD,
				)}, { algorithm: "bcrypt", cost: ${BCRYPT_COST} }))`,
			],
			{ encoding: "utf8" },
		).trim();
	}
	return cachedPasswordHash;
}

/** State root lives under the gitignored repo-local test-results dir (Rule D). */
const STATE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../test-results/worker-backends",
);

export interface WorkerBackend {
	port: number;
	stop(): Promise<void>;
}

/** Bounded by `workers`, so ports never grow across retries/respawns. */
export function workerBackendPort(): number {
	const idx = Number.parseInt(process.env.TEST_PARALLEL_INDEX ?? "0", 10);
	return BASE_PORT + (Number.isFinite(idx) ? idx : 0);
}

function probePort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		const finish = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitUntilListening(port: number): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await probePort(port)) return;
		await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
	}
	throw new Error(`worker backend never listened on :${port}`);
}

/**
 * setup.json points the backend at read-only mock binaries via `./mocks/...`
 * CWD-relative paths. The mocks are shared (read-only), so rewrite them to
 * absolute paths under the real backend dir; isolate only the writable
 * `ips_file` per worker. config.json/auth_tokens.json stay CWD-relative so each
 * worker reads/writes its OWN copy in the state dir.
 */
function seedSetupJson(stateDir: string): void {
	const src = path.join(BACKEND_DIR, "setup.json");
	if (!fs.existsSync(src)) {
		throw new Error(`worker backend seed missing: ${src}`);
	}
	const setup = JSON.parse(fs.readFileSync(src, "utf8")) as Record<
		string,
		unknown
	>;
	for (const [key, value] of Object.entries(setup)) {
		if (typeof value === "string" && value.startsWith("./mocks/")) {
			setup[key] = path.join(BACKEND_DIR, value);
		}
	}
	setup.ips_file = path.join(stateDir, "srtla_ips");
	fs.writeFileSync(path.join(stateDir, "setup.json"), JSON.stringify(setup));
}

function seedStateDir(stateDir: string): void {
	fs.rmSync(stateDir, { recursive: true, force: true });
	fs.mkdirSync(stateDir, { recursive: true });
	for (const file of STATE_FILES) {
		const src = path.join(BACKEND_DIR, file);
		if (!fs.existsSync(src)) {
			throw new Error(
				`worker backend seed missing: ${src} (globalSetup must run first)`,
			);
		}
		fs.copyFileSync(src, path.join(stateDir, file));
	}
	const cfgPath = path.join(stateDir, "config.json");
	const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<
		string,
		unknown
	>;
	cfg.password_hash = passwordHash();
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	seedSetupJson(stateDir);
}

function stopChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
		child.once("exit", () => {
			clearTimeout(kill);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

export async function startWorkerBackend(): Promise<WorkerBackend> {
	const port = workerBackendPort();
	const stateDir = path.join(STATE_ROOT, String(port));
	seedStateDir(stateDir);

	const logFd = fs.openSync(path.join(stateDir, "backend.log"), "w");
	const child = spawn("bun", [BACKEND_ENTRY], {
		cwd: stateDir,
		env: {
			...process.env,
			NODE_ENV: "development",
			MOCK_SCENARIO: "multi-modem-wifi",
			PORT: String(port),
		},
		stdio: ["ignore", logFd, logFd],
	});
	fs.closeSync(logFd);

	try {
		await waitUntilListening(port);
	} catch (error) {
		await stopChild(child);
		throw error;
	}

	return {
		port,
		stop: () => stopChild(child),
	};
}
