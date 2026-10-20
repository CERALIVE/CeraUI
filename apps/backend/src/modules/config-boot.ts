/**
 * The boot owner of `config.json` availability.
 *
 * `loadConfig()` is strict: an unreadable or ambiguous file is refused, never
 * guessed. That refusal must not take the control server down with it — the
 * server is the operator's only way to see and repair the device. So:
 *
 *   - DAMAGED (read completely, refused by grammar or the safety schema, as a
 *     power cut leaves a truncated or zero-byte file): the exact bytes are
 *     archived beside the file, the first-run record replaces it and is loaded
 *     through the same `loadConfig()` a missing file takes. The only values
 *     carried over are well-formed credentials, which can only narrow access
 *     compared with a first boot. The operator is told where the copy is.
 *   - UNAVAILABLE (EIO/EAGAIN, a short or changed read): nothing is written. A
 *     few bounded attempts run before the bind; then the server binds anyway and
 *     one cancellable capped-backoff owner retries until a strict load succeeds.
 *     Until then getters and saves keep throwing, as `config.ts` already does.
 */

import { basename } from "node:path";
import { writeFileAtomicSync } from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
import {
	preserveDamagedRecord,
	readPersistentRecord,
} from "../helpers/persistent-record.ts";
import {
	parseRuntimeConfigAuthority,
	RuntimeConfigAuthorityError,
} from "../helpers/runtime-config-authority.ts";
import { getConfigFilePath, loadConfig } from "./config.ts";
import { STORED_STATE_LIMITS } from "./system/update-orchestrator/stored-state-file.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "./system/update-orchestrator/strict-authority-json.ts";
import { notificationBroadcast } from "./ui/notifications.ts";

export type RuntimeConfigBootOutcome =
	| "loaded"
	| "first-run-after-damage"
	| "unavailable";

export interface RuntimeConfigBootDeps {
	/** Resolves after `ms`, or early once `signal` aborts. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly onDamagedReset: (copy: string) => void;
}

const BOOT_RETRY_DELAYS_MS = [250, 1000] as const;
const RETRY_BASE_MS = 1000;
const RETRY_CEILING_MS = 60_000;
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SHADOW_HASH = /^\$[0-9a-z]+\$\S+$/;

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function announceDamagedReset(copy: string): void {
	const name = basename(copy);
	logger.error("config: damaged config.json archived; first-run settings", {
		copy,
	});
	notificationBroadcast(
		"config_damaged_reset",
		"error",
		`The device settings file was damaged and could not be read. CeraUI started with first-run settings and kept the damaged file as ${name}. Settings must be entered again; this does not mean streaming or updates are working.`,
		0,
		true,
		true,
		true,
		"notifications.configDamagedReset",
		{ copy: name },
	);
}

export const defaultRuntimeConfigBootDeps: RuntimeConfigBootDeps = {
	sleep: sleepFor,
	onDamagedReset: announceDamagedReset,
};

/** First-run settings, keeping only credentials that can solely restrict access. */
function firstRunRecord(bytes: Uint8Array): string {
	let doc: unknown;
	try {
		doc = parseAuthorityJson(decodeAuthorityUtf8(bytes));
	} catch {
		return "{}";
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc))
		return "{}";
	const fields = doc as Record<string, unknown>;
	const kept: Record<string, string> = {};
	const { password_hash, ssh_pass_hash, ssh_pass } = fields;
	if (typeof password_hash === "string" && BCRYPT_HASH.test(password_hash))
		kept.password_hash = password_hash;
	if (typeof ssh_pass_hash === "string" && SHADOW_HASH.test(ssh_pass_hash))
		kept.ssh_pass_hash = ssh_pass_hash;
	if (typeof ssh_pass === "string" && ssh_pass.length > 0)
		kept.ssh_pass = ssh_pass;
	return JSON.stringify(kept);
}

async function strictLoad(): Promise<boolean> {
	try {
		await loadConfig();
		return true;
	} catch (error) {
		if (error instanceof RuntimeConfigAuthorityError) return false;
		throw error;
	}
}

async function attemptRuntimeConfig(
	deps: RuntimeConfigBootDeps,
	notice: { copy: string | undefined },
): Promise<RuntimeConfigBootOutcome> {
	if (await strictLoad()) {
		if (notice.copy === undefined) return "loaded";
		deps.onDamagedReset(notice.copy);
		notice.copy = undefined;
		return "first-run-after-damage";
	}
	const path = getConfigFilePath();
	const read = await readPersistentRecord(
		path,
		STORED_STATE_LIMITS.packages,
		parseRuntimeConfigAuthority,
	);
	// Absent or valid here means the file changed under the load; retry it.
	if (read.kind !== "damaged") return "unavailable";
	let copy: string;
	try {
		copy = preserveDamagedRecord(path, read.bytes);
		writeFileAtomicSync(path, firstRunRecord(read.bytes));
		notice.copy = copy;
	} catch (err) {
		logger.error("config: damaged config.json could not be archived", { err });
		return "unavailable";
	}
	if (!(await strictLoad())) return "unavailable";
	deps.onDamagedReset(copy);
	notice.copy = undefined;
	return "first-run-after-damage";
}

const never = new AbortController().signal;
let stopper: AbortController | undefined;
let markReady: (() => void) | undefined;
let ready: Promise<void> = Promise.resolve();

async function retryUntilLoaded(
	deps: RuntimeConfigBootDeps,
	signal: AbortSignal,
	notice: { copy: string | undefined },
): Promise<void> {
	for (let delay = RETRY_BASE_MS; ; ) {
		await deps.sleep(delay, signal);
		if (signal.aborted) return;
		const outcome = await attemptRuntimeConfig(deps, notice).catch(
			(err: unknown) => {
				logger.error("config: background load failed", { err });
				return "unavailable" as const;
			},
		);
		if (outcome !== "unavailable") {
			logger.info("config: config.json readable again; boot continues");
			markReady?.();
			return;
		}
		delay = Math.min(delay * 2, RETRY_CEILING_MS);
	}
}

/**
 * Load config for boot. Resolves `unavailable` instead of throwing when the
 * file stays unreadable, after starting the background owner;
 * {@link awaitRuntimeConfig} resolves once that owner has loaded it.
 */
export async function bootRuntimeConfig(
	deps: RuntimeConfigBootDeps = defaultRuntimeConfigBootDeps,
): Promise<RuntimeConfigBootOutcome> {
	const notice: { copy: string | undefined } = { copy: undefined };
	for (const delay of [...BOOT_RETRY_DELAYS_MS, undefined]) {
		const outcome = await attemptRuntimeConfig(deps, notice);
		if (outcome !== "unavailable") return outcome;
		if (delay !== undefined) await deps.sleep(delay, never);
	}
	stopRuntimeConfigRecovery();
	const controller = new AbortController();
	stopper = controller;
	ready = new Promise((resolve) => {
		markReady = resolve;
	});
	logger.error("config: config.json unreadable; serving without it", {
		path: getConfigFilePath(),
	});
	void retryUntilLoaded(deps, controller.signal, notice);
	return "unavailable";
}

/** Resolves once config is loaded; stays pending after a shutdown stop. */
export function awaitRuntimeConfig(): Promise<void> {
	return ready;
}

export function stopRuntimeConfigRecovery(): void {
	stopper?.abort();
	stopper = undefined;
}
