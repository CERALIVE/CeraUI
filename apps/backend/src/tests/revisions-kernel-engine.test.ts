/*
 * Settings → Versions gained two rows an operator could not previously see: the
 * board's running kernel, and the cerastream engine version.
 *
 * The engine one is the load-bearing case. cerastream is a systemd-owned
 * process CeraUI CONNECTS to (it never spawns it), it can be restarted or
 * upgraded underneath a running backend, and its version was already arriving on
 * every `hello` handshake — it was simply never surfaced. So the two properties
 * worth pinning are that the value is a REAL live read (never a literal), and
 * that an unreachable engine is reported honestly instead of serving a version
 * the device can no longer vouch for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { release } from "node:os";

import {
	ENGINE_UNREACHABLE_REVISION,
	getRevisions,
	initRevisions,
	refreshEngineRevision,
	setEngineVersionProbe,
} from "../modules/system/revisions.ts";

afterEach(() => {
	setEngineVersionProbe(null);
});

describe("revisions — kernel row", () => {
	test("initRevisions() publishes the board's running kernel release", async () => {
		setEngineVersionProbe(async () => undefined);
		await initRevisions();
		expect(getRevisions().kernel).toBe(release());
		expect(getRevisions().kernel?.length).toBeGreaterThan(0);
	});
});

describe("revisions — cerastream engine row", () => {
	test("a reachable engine publishes the version it reported on `hello`", async () => {
		setEngineVersionProbe(async () => "2026.7.2");
		await refreshEngineRevision();
		expect(getRevisions().cerastream).toBe("2026.7.2");
	});

	test("an unreachable engine reports that honestly, never a stale version", async () => {
		setEngineVersionProbe(async () => "2026.7.2");
		await refreshEngineRevision();
		expect(getRevisions().cerastream).toBe("2026.7.2");

		// The engine went away (crash, restart, systemd stop). The previously
		// observed version is no longer something the device can vouch for, so it
		// must NOT be retained — a cached-forever value would keep claiming a
		// version that may not even be installed any more.
		setEngineVersionProbe(async () => undefined);
		await refreshEngineRevision();
		expect(getRevisions().cerastream).toBe(ENGINE_UNREACHABLE_REVISION);
	});

	test("a probe that throws degrades to the honest value instead of propagating", async () => {
		setEngineVersionProbe(async () => {
			throw new Error("ECONNREFUSED");
		});
		await expect(refreshEngineRevision()).resolves.toBe(
			ENGINE_UNREACHABLE_REVISION,
		);
	});

	test("a re-probe adopts a NEW version after an engine upgrade", async () => {
		setEngineVersionProbe(async () => "2026.7.2");
		await refreshEngineRevision();
		setEngineVersionProbe(async () => "2026.8.0");
		await refreshEngineRevision();
		expect(getRevisions().cerastream).toBe("2026.8.0");
	});
});
