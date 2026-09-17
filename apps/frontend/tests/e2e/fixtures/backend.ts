import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { leaseBackendPort } from "./backend-port.js";

/**
 * Per-worker mock-backend lifecycle for the Playwright e2e suite.
 *
 * Each acquisition spawns its OWN backend on a leased port with its OWN
 * working directory, so the backend's CWD-relative state files (`config.json`,
 * `auth_tokens.json`, `setup.json` — see apps/backend AGENTS.md "Config files …
 * read/written from working dir") are isolated per worker. This removes both
 * shared-`config.json` clobbering AND `dev.emit` broadcast bleed across workers,
 * which is what previously forced `workers: 2` and the broad `serial` cordon.
 *
 * One frontend server per E2E run (or CI lane) remains stateless while each page
 * is routed to its worker backend. Local E2E uses `window.__ceraSocketPort`; CI
 * uses the production preview WebSocket proxy and a fixture-owned HttpOnly cookie.
 */

const BACKEND_DIR = path.resolve(import.meta.dirname, "../../../../backend");
const BACKEND_ENTRY = path.join(import.meta.dirname, "backend-entry.ts");

/** Mutable CWD-relative state files; each acquisition owns its copy. */
const STATE_FILES = ["config.json", "auth_tokens.json"] as const;

/** Preferred slot; local leases skip occupied slots without changing parallelism. */
const BASE_PORT = 3100;
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 4_000;

/**
 * Default mock scenario for a worker backend. A spec requiring a different
 * backend state opts in per-worker via `test.use({ backendScenario: '…' })`
 * (see fixtures/index.ts + PLAYBOOK.md) — a scenario override forces Playwright
 * to allocate a separate worker, so parallel workers never share a mismatched
 * backend (the scenario is part of the worker key).
 */
const DEFAULT_SCENARIO = "multi-modem-wifi";

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
	readonly port: number;
	readonly previewPort: number;
	readonly proxySecret: string;
	stop(): Promise<void>;
}

/** Bounded by `workers`, so ports never grow across retries/respawns. */
export function workerBackendPort(): number {
	const idx = Number.parseInt(process.env.TEST_PARALLEL_INDEX ?? "0", 10);
	return BASE_PORT + (Number.isFinite(idx) ? idx : 0);
}

function waitUntilReady(
	child: ChildProcess,
	requestedPort: number,
	logPath: string,
): Promise<{ port: number; previewPort: number }> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(new Error(`worker backend startup failed; see ${logPath}`, { cause: error }));
		};
		const onExit = (code: number | null, signal: string | null) => {
			onError(new Error(`worker backend exited before readiness (${code ?? signal})`));
		};
		const onMessage = (message: unknown) => {
			if (
				typeof message !== "object" || message === null ||
				!("type" in message) || message.type !== "backend-ready" ||
				!("port" in message) || typeof message.port !== "number" ||
				!("previewPort" in message) || typeof message.previewPort !== "number" ||
				!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
				!Number.isInteger(message.previewPort) || message.previewPort < 1 || message.previewPort > 65535
			) {
				onError(new Error("worker backend sent invalid readiness"));
				return;
			}
			if (requestedPort !== 0 && message.port !== requestedPort) {
				onError(new Error(`worker backend bound unexpected port ${message.port}, requested ${requestedPort}`));
				return;
			}
			cleanup();
			resolve({ port: message.port, previewPort: message.previewPort });
		};
		const timeout = setTimeout(() => {
			onError(new Error("worker backend readiness timed out"));
		}, READY_TIMEOUT_MS);
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
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
	// Scenario mutations (PIN retries/unlock included) are owned by the legacy
	// mock modem state machine, so worker fixtures must opt out of the production
	// D-Bus default rather than inheriting an unrelated read-only view.
	cfg.modem_backend = "mmcli";
	cfg.password_hash = passwordHash();
	cfg.kiosk_enabled = false;
	cfg.kiosk_last_state = "disabled";
	cfg.kiosk_display = "lcd";
	cfg.kiosk_touch = true;
	cfg.kiosk_motion = true;
	cfg.kiosk_performance = "balanced";
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	seedSetupJson(stateDir);
}

function stopChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
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

export interface StartWorkerBackendOptions {
	/** MOCK_SCENARIO to boot this worker's backend with (default multi-modem-wifi). */
	scenario?: string;
	port?: number;
}

export async function startWorkerBackend(
	options: StartWorkerBackendOptions = {},
): Promise<WorkerBackend> {
	const lease = options.port === undefined && process.env.CI !== "true"
		? await leaseBackendPort(workerBackendPort())
		: undefined;
	try {
		const backend = await spawnWorkerBackend({
			...options,
			port: options.port ?? lease?.port ?? workerBackendPort(),
		});
		let stopped: Promise<void> | undefined;
		return {
			...backend,
			stop: () => {
				stopped ??= backend.stop().finally(() => lease?.release());
				return stopped;
			},
		};
	} catch (error) {
		await lease?.release();
		throw error;
	}
}

async function spawnWorkerBackend(
	options: StartWorkerBackendOptions & { port: number },
): Promise<WorkerBackend> {
	const scenario = options.scenario ?? DEFAULT_SCENARIO;
	const port = options.port;
	const proxySecret = randomBytes(32).toString("hex");
	fs.mkdirSync(STATE_ROOT, { recursive: true });
	const stateDir = fs.mkdtempSync(path.join(STATE_ROOT, `${port}-`));
	seedStateDir(stateDir);

	const logPath = path.join(stateDir, "backend.log");
	const logFd = fs.openSync(logPath, "w");
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "development",
		MOCK_SCENARIO: scenario,
		PORT: String(port),
		PREVIEW_PORT: "0",
	};
	if (process.env.CI === "true") {
		childEnv.E2E_WORKER_PROXY_SECRET = proxySecret;
	} else {
		delete childEnv.E2E_WORKER_PROXY_SECRET;
	}
	const child = spawn("bun", [BACKEND_ENTRY], {
		cwd: stateDir,
		env: childEnv,
		stdio: ["ignore", logFd, logFd, "ipc"],
	});
	fs.closeSync(logFd);

	try {
		const ready = await waitUntilReady(child, port, logPath);
		return {
			...ready,
			proxySecret,
			stop: () => stopChild(child),
		};
	} catch (error) {
		await stopChild(child);
		throw error;
	}
}
