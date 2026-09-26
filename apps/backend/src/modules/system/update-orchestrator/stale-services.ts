import { readdir } from "node:fs/promises";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { notifyUpdate } from "./notifications.ts";

const UNIT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/;
const STALE_SYSTEM_MAPPING = /\s(\/(?:usr|lib)\/[^\n]*?) \(deleted\)$/m;

export function owningService(cgroup: string): string | undefined {
	for (const line of cgroup.split("\n")) {
		const path = line.slice(line.indexOf("::") + 2);
		const service = path.split("/").find((part) => UNIT_NAME.test(part));
		if (service) return service;
	}
	return undefined;
}

export function mayRestartUnit(
	unit: string,
	transactionRunning: boolean,
): boolean {
	if (!UNIT_NAME.test(unit)) return false;
	const name = unit.slice(0, -".service".length);
	if (name === "ceralive") return !transactionRunning;
	return !(
		name.startsWith("systemd") ||
		name === "dbus" ||
		name.startsWith("dbus-") ||
		name.startsWith("NetworkManager") ||
		name.startsWith("ModemManager") ||
		name.startsWith("wpa_supplicant") ||
		name.startsWith("rauc") ||
		name.startsWith("pipewire") ||
		name.startsWith("wireplumber")
	);
}

export async function scanStaleUnits(procRoot = "/proc"): Promise<string[]> {
	const units = new Set<string>();
	for (const entry of await readdir(procRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const dir = `${procRoot}/${entry.name}`;
		try {
			const maps = await Bun.file(`${dir}/maps`).text();
			if (!maps.split("\n").some((line) => STALE_SYSTEM_MAPPING.test(line)))
				continue;
			const unit = owningService(await Bun.file(`${dir}/cgroup`).text());
			if (unit) units.add(unit);
		} catch (error) {
			// A process may exit while /proc is read; unreadable entries grant no restart.
			if (error instanceof Error) continue;
			throw error;
		}
	}
	return [...units].sort();
}

export interface StaleServiceDeps {
	readonly procRoot?: string;
	readonly units?: readonly string[];
	readonly isIdle: () => Promise<boolean>;
	readonly transactionRunning: () => boolean;
	readonly restart: (unit: string) => Promise<void>;
	readonly recommend: (unit: string) => void;
}

/** False means eligible units still need an idle window; re-scan next tick. */
export async function reconcileStaleUnits(
	deps: StaleServiceDeps,
): Promise<boolean> {
	const units = deps.units ?? (await scanStaleUnits(deps.procRoot));
	let pending = false;
	for (const unit of units) {
		if (!mayRestartUnit(unit, deps.transactionRunning())) {
			deps.recommend(unit);
			if (unit === "ceralive.service") pending = true;
			continue;
		}
		if (!(await deps.isIdle())) {
			pending = true;
			continue;
		}
		await deps.restart(unit);
	}
	return !pending;
}

export const defaultStaleServiceDeps: StaleServiceDeps = {
	isIdle: async () => false,
	transactionRunning: () => true,
	restart: async (unit) => {
		const result = await spawnWithTimeout(
			["systemctl", "restart", "--no-block", unit],
			{ timeoutMs: 10_000 },
		);
		if (result.exitCode !== 0)
			throw new Error(`Service restart refused: ${unit}`);
	},
	recommend: (unit) => {
		notifyUpdate({ kind: "restart-recommended", id: unit, unit });
	},
};
