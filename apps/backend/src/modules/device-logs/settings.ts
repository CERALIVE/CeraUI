import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LogRetention, logRetentionSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger, setJournalDetail } from "../../helpers/logger.ts";

const settingsFile = "log-settings.json";
const stateFile = "log-state.json";
const defaultSettings: LogRetention = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
};
const logStateSchema = z.strictObject({
	historyEpoch: z.number().int().nonnegative(),
	lastClearedAt: z.number().int().nonnegative().nullable(),
	lastMaintenance: z
		.strictObject({
			at: z.number().int().nonnegative(),
			ok: z.boolean(),
			targetMet: z.boolean(),
		})
		.nullable(),
});
type LogState = z.infer<typeof logStateSchema>;

const defaultState: LogState = {
	historyEpoch: 0,
	lastClearedAt: null,
	lastMaintenance: null,
};

let settingsDir: string | null = null;
let settings = defaultSettings;
let state = defaultState;
let settingsLoaded = false;
let stateLoaded = false;
let historyClear: ReturnType<typeof Promise.withResolvers<void>> | null = null;

export function historyClearing(): Promise<void> | null {
	return historyClear?.promise ?? null;
}

/** Called only by retention's exclusive clear transaction. */
export function beginHistoryClear(): () => void {
	updateLogState({ historyEpoch: getLogState().historyEpoch + 1 });
	const pending = Promise.withResolvers<void>();
	historyClear = pending;
	return () => {
		if (historyClear !== pending) return;
		historyClear = null;
		pending.resolve();
	};
}

function filePath(name: string): string {
	return join(settingsDir ?? process.cwd(), name);
}

function readStored<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		logger.warn(`Failed to read log settings file: ${path}`);
		return fallback;
	}

	try {
		return schema.parse(JSON.parse(raw));
	} catch {
		logger.warn(`Invalid log settings file: ${path}`);
		return fallback;
	}
}

function loadSettings(): LogRetention {
	return readStored(
		filePath(settingsFile),
		logRetentionSchema,
		defaultSettings,
	);
}

function loadState(): LogState {
	return readStored(filePath(stateFile), logStateSchema, defaultState);
}

export function initLogSettings(): void {
	settings = loadSettings();
	settingsLoaded = true;
	state = loadState();
	stateLoaded = true;
	setJournalDetail(settings.detail);
}

export function getLogSettings(): LogRetention {
	if (!settingsLoaded) {
		settings = loadSettings();
		settingsLoaded = true;
	}
	return { ...settings };
}

export function saveLogSettings(next: unknown): LogRetention {
	const parsed = logRetentionSchema.parse(next);
	writeFileAtomicSync(filePath(settingsFile), JSON.stringify(parsed));
	settings = parsed;
	settingsLoaded = true;
	return { ...settings };
}

export function getLogState(): LogState {
	if (!stateLoaded) {
		state = loadState();
		stateLoaded = true;
	}
	return structuredClone(state);
}

export function updateLogState(patch: Partial<LogState>): LogState {
	const parsedPatch = logStateSchema.partial().parse(patch);
	const next = logStateSchema.parse({ ...getLogState(), ...parsedPatch });
	writeFileAtomicSync(filePath(stateFile), JSON.stringify(next));
	state = next;
	stateLoaded = true;
	return structuredClone(state);
}

export function setLogSettingsDirForTest(dir: string | null): void {
	settingsDir = dir;
	settings = defaultSettings;
	state = defaultState;
	settingsLoaded = false;
	stateLoaded = false;
}
