/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DAY = 86_400_000;
const EXPIRY = 180 * DAY;
// Three real VM/import/journal reloads share this test's scheduling budget.
const SESSION_TIMEOUT_MS = 15_000;
const RESTART_TEST_TIMEOUT_MS = 3 * SESSION_TIMEOUT_MS + 5_000;
const resultSchema = z.object({
	names: z.array(z.string()),
	keys: z.array(z.string()),
	state: z.enum(["valid", "expiring", "expired", "unavailable"]),
});
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "credential-clock-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function session(now: number) {
	const base = new URL("../modules/", import.meta.url);
	const source = `
		import {CredentialNoticeLedger} from ${JSON.stringify(new URL("system/update-orchestrator/credential-ledger.ts", base).href)};
		import {CredentialNoticeObserver} from ${JSON.stringify(new URL("system/update-orchestrator/credential-notice-observer.ts", base).href)};
		import {credentialIntentId,credentialIntentKind} from ${JSON.stringify(new URL("system/update-orchestrator/credential-ledger-state.ts", base).href)};
		import {notifyUpdate,clearUpdateNotice} from ${JSON.stringify(new URL("system/update-orchestrator/notifications.ts", base).href)};
		import {getPersistentNotifications} from ${JSON.stringify(new URL("ui/notifications.ts", base).href)};
		const observer = new CredentialNoticeObserver({
			now:()=>${now},
			read:async()=>({kind:"known",expiresAt:${EXPIRY},digest:"a".repeat(64)}),
			ledger:new CredentialNoticeLedger({path:${JSON.stringify(join(root, "ledger.json"))}}),
			dismissed:()=>false,
			clear:(intent)=>clearUpdateNotice(credentialIntentKind(intent),credentialIntentId(intent)),
			publish:(notice,beforeDismiss)=>notifyUpdate(notice,{beforeDismiss}),
		});
		await observer.refresh(true);
		const notices = getPersistentNotifications(true).show;
		console.log(JSON.stringify({names:notices.map(n=>n.name),keys:notices.map(n=>n.key),state:observer.details().state}));
	`;
	await using child = Bun.spawn([process.execPath, "-e", source], {
		timeout: SESSION_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			CERALIVE_DISMISSALS_FILE: join(root, "dismissals.json"),
		},
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const line = stdout.trim().split("\n").at(-1);
	return resultSchema.parse(JSON.parse(line ?? "null"));
}

test.each([
	{
		remaining: 20 * DAY,
		key: "notifications.updateCredentialsExpiring",
		state: "expiring",
	},
	{
		remaining: -5 * DAY,
		key: "notifications.updateCredentialsExpired",
		state: "expired",
	},
] as const)(
	"keeps $state notice identity across fresh-process early-clock boot and correction",
	async ({ remaining, key, state }) => {
		// Given a real child published an undismissed warning into its private journal.
		const first = await session(EXPIRY - remaining);
		expect(first.keys).toEqual([key]);
		// When two fresh processes reload at boot epoch and then corrected time.
		const early = await session(EXPIRY - 420 * DAY);
		const corrected = await session(EXPIRY - remaining + 30_000);
		// Then continuity preserves the exact notice name and never claims valid before sync.
		expect(early.names).toEqual(first.names);
		expect(early.state).toBe("unavailable");
		expect(corrected.names).toEqual(first.names);
		expect(corrected.state).toBe(state);
	},
	RESTART_TEST_TIMEOUT_MS,
);
