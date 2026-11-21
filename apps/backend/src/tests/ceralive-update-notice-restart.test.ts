/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend twice, and a tab can be offline for both. Each session below is a real
 * fresh backend process sharing only the files a device keeps, so nothing here
 * can pass by reusing one process's notification map.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import {
	initCeraliveUpdateNotice,
	reconcileCeraliveUpdateNotice,
	resetCeraliveUpdateNoticeForTest,
} from "../modules/system/ceralive-update-notice.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";

const NOTICE = "ceralive_update";
const SESSION_TIMEOUT_MS = 45_000;
const SEQUENCE_TIMEOUT_MS = 6 * SESSION_TIMEOUT_MS;
const replaySchema = z.object({
	show: z.array(z.string()),
	remove: z.array(z.string()),
});

type Offer = readonly { readonly name: string; readonly version: string }[];
type Step = { readonly reconcile?: Offer; readonly dismiss?: boolean };

let root: string;
let record: string;
let dismissals: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ceralive-update-restart-"));
	record = join(root, "ceralive_update_offer.json");
	dismissals = join(root, "dismissals.json");
});

afterEach(async () => {
	resetCeraliveUpdateNoticeForTest();
	notificationRemove(NOTICE);
	await rm(root, { recursive: true, force: true });
});

async function session(step: Step = {}) {
	const base = new URL("../modules/", import.meta.url);
	const source = `
		import {initCeraliveUpdateNotice,reconcileCeraliveUpdateNotice} from ${JSON.stringify(new URL("system/ceralive-update-notice.ts", base).href)};
		import {getPersistentNotifications,notificationDismiss} from ${JSON.stringify(new URL("ui/notifications.ts", base).href)};
		const step = ${JSON.stringify(step)};
		initCeraliveUpdateNotice(${JSON.stringify(record)});
		if (step.reconcile) reconcileCeraliveUpdateNotice(step.reconcile);
		if (step.dismiss) notificationDismiss(${JSON.stringify(NOTICE)});
		const replay = getPersistentNotifications(true);
		console.log(JSON.stringify({show:replay.show.map((n)=>n.name),remove:(replay.remove??[]).map((r)=>r.id)}));
	`;
	await using child = Bun.spawn([process.execPath, "-e", source], {
		timeout: SESSION_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CERALIVE_DISMISSALS_FILE: dismissals },
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exit, stderr: exit === 0 ? "" : stderr }).toEqual({
		exit: 0,
		stderr: "",
	});
	return replaySchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
}

const CURRENT = [{ name: "cerastream", version: "2026.11.3" }];
const NEXT = [{ name: "cerastream", version: "2026.12.1" }];
const SHOWN = { show: [NOTICE], remove: [] };
const WITHDRAWN = { show: [], remove: [NOTICE] };
const NOTHING = { show: [], remove: [] };

test(
	"the withdrawal after an update reaches a tab that missed every restart",
	async () => {
		// Given the offer a tab is showing.
		expect(await session({ reconcile: CURRENT })).toEqual(SHOWN);
		// When the package script restarts the backend before any check: no evidence changes.
		expect(await session()).toEqual(NOTHING);
		// When the completion restart's conclusive check finds nothing, and that process exits unseen.
		expect(await session({ reconcile: [] })).toEqual(WITHDRAWN);
		// Then a later process whose own check cannot complete still tells the tab.
		expect(await session()).toEqual(WITHDRAWN);
		// And the withdrawal never hides a newer release.
		expect(await session({ reconcile: NEXT })).toEqual(SHOWN);
		expect(await session()).toEqual(NOTHING);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a dismissal reaches other tabs after a restart and covers that release only",
	async () => {
		expect(await session({ reconcile: CURRENT, dismiss: true })).toEqual(
			WITHDRAWN,
		);
		expect(await session()).toEqual(WITHDRAWN);
		expect(await session({ reconcile: CURRENT })).toEqual(WITHDRAWN);
		expect(await session({ reconcile: NEXT })).toEqual(SHOWN);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"startup derives nothing without a readable record and acknowledgement store",
	async () => {
		// Given no record at all.
		expect(await session()).toEqual(NOTHING);
		// Given a corrupt record.
		await writeFile(record, "{");
		expect(await session()).toEqual(NOTHING);
		// Given an offer whose dismissal state cannot be read.
		expect(await session({ reconcile: CURRENT })).toEqual(SHOWN);
		await mkdir(dismissals);
		expect(await session()).toEqual(NOTHING);
		// A proven absence needs no acknowledgement store.
		expect(await session({ reconcile: [] })).toEqual(WITHDRAWN);
		expect(await session()).toEqual(WITHDRAWN);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a record that cannot be rewritten for a newer offer is deleted, not left as a withdrawal",
	async () => {
		// Given a persisted "nothing pending".
		expect(await session({ reconcile: [] })).toEqual(WITHDRAWN);
		initCeraliveUpdateNotice(record);
		// When the write for a newer offer fails.
		await mkdir(
			join(dirname(record), `.${basename(record)}.${process.pid}.tmp`),
		);
		reconcileCeraliveUpdateNotice(CURRENT);
		// Then no stale withdrawal can survive into the next process.
		expect(existsSync(record)).toBe(false);
		expect(await session()).toEqual(NOTHING);
	},
	SEQUENCE_TIMEOUT_MS,
);
