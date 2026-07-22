/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Durable notification-dismissal store (device-quality-wave2 Todo 23c/d).
 *
 * Records which notifications an operator dismissed, keyed by SEMANTIC identity
 * (for update notifications: the version string), so a dismissal survives a page
 * reload AND a backend restart — the in-memory Map it replaces did neither.
 *
 * Durability model (mirrors config.json — see docs/CONFIG_PERSISTENCE.md):
 *   - writes are atomic (temp file → fsync → rename), so a crash mid-write can
 *     never truncate the committed file.
 *   - the set is LRU-bounded; the oldest dismissal is evicted past the cap so a
 *     device that runs for years never grows the file without bound.
 *   - an unparseable/wrong-shape file is QUARANTINED (renamed aside), the store
 *     starts fresh, and the event is logged — a corrupt file never crashes boot.
 */

import fs from "node:fs";

import { z } from "zod";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

export { writeFileAtomicSync };

export const DISMISSAL_STORE_VERSION = 1;
export const DEFAULT_MAX_DISMISSALS = 256;

const dismissalFileSchema = z.object({
	version: z.number(),
	entries: z.array(z.object({ key: z.string(), dismissedAt: z.number() })),
});

export interface DismissalStoreDeps {
	readText(target: string): string | undefined;
	writeAtomic(target: string, contents: string): void;
	quarantine(target: string, corruptPath: string): void;
	now(): number;
	logCorruption(target: string, corruptPath: string, err: unknown): void;
}

const defaultDeps: DismissalStoreDeps = {
	readText(target) {
		try {
			return fs.readFileSync(target, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	},
	writeAtomic(target, contents) {
		writeFileAtomicSync(target, contents);
	},
	quarantine(target, corruptPath) {
		fs.renameSync(target, corruptPath);
	},
	now() {
		return Date.now();
	},
	logCorruption(target, corruptPath, err) {
		logger.warn(
			`Corrupt notification-dismissal store ${target}; quarantined to ${corruptPath} and starting fresh: ${err}`,
		);
	},
};

export interface DismissalStoreOptions {
	path: string;
	maxEntries?: number;
	deps?: Partial<DismissalStoreDeps>;
}

export class NotificationDismissalStore {
	private readonly path: string;
	private readonly maxEntries: number;
	private readonly deps: DismissalStoreDeps;
	// Insertion order is LRU order: the front is the least-recently-dismissed.
	private entries = new Map<string, number>();

	constructor(options: DismissalStoreOptions) {
		this.path = options.path;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_DISMISSALS;
		this.deps = { ...defaultDeps, ...options.deps };
	}

	load(): void {
		const raw = this.deps.readText(this.path);
		if (raw === undefined) {
			this.entries = new Map();
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			this.quarantineAndReset(err);
			return;
		}

		const result = dismissalFileSchema.safeParse(parsed);
		if (!result.success) {
			this.quarantineAndReset(result.error);
			return;
		}

		this.entries = new Map();
		for (const entry of result.data.entries) {
			this.entries.set(entry.key, entry.dismissedAt);
		}
		this.evictOverflow();
	}

	isDismissed(key: string): boolean {
		return this.entries.has(key);
	}

	recordDismissal(key: string): void {
		this.entries.delete(key);
		this.entries.set(key, this.deps.now());
		this.evictOverflow();
		this.persist();
	}

	size(): number {
		return this.entries.size;
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	clear(): void {
		this.entries = new Map();
	}

	private evictOverflow(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	private persist(): void {
		const file = {
			version: DISMISSAL_STORE_VERSION,
			entries: [...this.entries].map(([key, dismissedAt]) => ({
				key,
				dismissedAt,
			})),
		};
		this.deps.writeAtomic(this.path, JSON.stringify(file));
	}

	private quarantineAndReset(err: unknown): void {
		const corruptPath = `${this.path}.corrupt-${this.deps.now()}`;
		try {
			this.deps.quarantine(this.path, corruptPath);
			this.deps.logCorruption(this.path, corruptPath, err);
		} catch (quarantineErr) {
			logger.warn(
				`Failed to quarantine corrupt notification-dismissal store ${this.path}: ${quarantineErr}`,
			);
		}
		this.entries = new Map();
	}
}

const DEFAULT_DISMISSALS_FILE = "notification_dismissals.json";

function dismissalsPath(): string {
	return process.env.CERALIVE_DISMISSALS_FILE ?? DEFAULT_DISMISSALS_FILE;
}

let singleton: NotificationDismissalStore | undefined;

export function getDismissalStore(): NotificationDismissalStore {
	if (!singleton) {
		singleton = new NotificationDismissalStore({ path: dismissalsPath() });
		singleton.load();
	}
	return singleton;
}

export function isNotificationDismissed(key: string): boolean {
	return getDismissalStore().isDismissed(key);
}

export function recordNotificationDismissal(key: string): void {
	getDismissalStore().recordDismissal(key);
}

export function resetDismissalStoreForTests(): void {
	singleton = undefined;
}
