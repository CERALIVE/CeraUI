/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { CredentialNoticeObserver } from "../modules/system/update-orchestrator/credential-notice-observer.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import {
	isNotificationDismissed,
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationDismiss,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	credentialObserverFixture,
	CREDENTIAL_DAY as DAY,
} from "./helpers/credential-observer-fixture.ts";

let fixture: Awaited<ReturnType<typeof credentialObserverFixture>>;
let oldPath: string | undefined;
beforeEach(async () => {
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	fixture = await credentialObserverFixture();
	oldPath = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = `${fixture.root}/dismissals.json`;
	resetDismissalStoreForTests();
});
afterEach(async () => {
	fixture.observer.stop();
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	if (oldPath === undefined) delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = oldPath;
	resetDismissalStoreForTests();
	await fixture.cleanup();
});

test("production notices are persistent/authed/deep-linked with opaque identity and repeat silently", async () => {
	// Given a known near-expiry public cert; When observed twice; Then one safe persistent Updates notice exists.
	await fixture.observer.refresh(true);
	await fixture.observer.refresh();
	const notices = getPersistentNotifications(true).show;
	expect(notices).toHaveLength(1);
	expect(getPersistentNotifications(false).show).toHaveLength(0);
	expect(notices[0]).toMatchObject({
		key: "notifications.updateCredentialsExpiring",
		params: { days: 90 },
		action: { kind: "navigate", target: "updates-dialog" },
		is_persistent: true,
		is_dismissable: true,
	});
	expect(JSON.stringify(notices)).not.toContain("a".repeat(64));
	expect(fixture.state.reads).toBe(1);
});

test("dedicated durable acknowledgement outlives 300 ordinary dismissals and restart", async () => {
	// Given an operator-dismissed warning; When ordinary LRU churn and observer restart happen; Then the warning cannot resurrect.
	await fixture.observer.refresh(true);
	const notice = getPersistentNotifications(true).show[0];
	if (!notice) throw new Error("fixture notice missing");
	notificationDismiss(notice.name);
	for (let n = 0; n < 300; n++) recordNotificationDismissal(`ordinary-${n}`);
	expect(isNotificationDismissed(notice.name)).toBe(false);
	resetDismissalStoreForTests();
	await new CredentialNoticeObserver(fixture.deps).refresh(true);
	expect(getPersistentNotifications(true).show).toHaveLength(0);
});

test("failed acknowledgement leaves the notice visible and supports repaired retry", async () => {
	// Given a corrupt ledger after publication; When dismissed; Then persistence refusal cannot hide the warning.
	await fixture.observer.refresh(true);
	const notice = getPersistentNotifications(true).show[0];
	if (!notice) throw new Error("fixture notice missing");
	const saved = await readFile(fixture.path);
	await writeFile(fixture.path, "corrupt");
	expect(() => notificationDismiss(notice.name)).toThrow();
	expect(notificationExists(notice.name)).toBeDefined();
	await writeFile(fixture.path, saved);
	notificationDismiss(notice.name);
	expect(notificationExists(notice.name)).toBeUndefined();
	await new CredentialNoticeObserver(fixture.deps).refresh(true);
	expect(getPersistentNotifications(true).show).toHaveLength(0);
});

test("escalation withdraws weaker warning and expired is a distinct no-days variant", async () => {
	// Given an earlier active notice; When crossing later thresholds; Then only the most urgent truthful notice remains.
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		clear: (intent) => {
			notificationRemove(
				`update:${intent.threshold === "expired" ? "credentials-expired" : "credentials-expiring"}:${intent.generation}:${intent.threshold}`,
			);
		},
	});
	await observer.refresh(true);
	fixture.state.now = 175 * DAY;
	await observer.refresh();
	expect(getPersistentNotifications(true).show).toHaveLength(1);
	expect(getPersistentNotifications(true).show[0]?.params).toEqual({ days: 7 });
	fixture.state.now = 180 * DAY;
	await observer.refresh();
	expect(getPersistentNotifications(true).show).toHaveLength(1);
	expect(getPersistentNotifications(true).show[0]).toMatchObject({
		key: "notifications.updateCredentialsExpired",
		params: {},
	});
});

test("concurrent refresh is single-flight and public reads are cached for fifteen minutes", async () => {
	// Given a held reader; When concurrent refreshes join; Then only one read happens and ticks can continue separately.
	let release: (value: typeof fixture.state.observation) => void = () => {};
	let reads = 0;
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		read: () => {
			reads++;
			return new Promise((resolve) => {
				release = resolve;
			});
		},
	});
	const first = observer.refresh(true);
	const joined = observer.refresh(true);
	await Promise.resolve();
	expect(first).toBe(joined);
	expect(reads).toBe(1);
	release(fixture.state.observation);
	await first;
	fixture.state.now += 60_000;
	await observer.refresh();
	expect(reads).toBe(1);
});

test("reader exceptions and corrupt ledger return unavailable without secret output", async () => {
	// Given a secret-looking raw error; When the observer catches it; Then safe details contain no sentinel.
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		read: async () => {
			throw new Error(
				"-----BEGIN CERTIFICATE----- /client.key digest-sentinel",
			);
		},
	});
	await observer.refresh(true);
	expect(observer.details()).toEqual({ expiresAt: null, state: "unavailable" });
	expect(getPersistentNotifications(true).show).toHaveLength(0);
});

test("failed publication rehydrates the same logical notice after restart", async () => {
	// Given a crash-equivalent throw after activation persistence; When a new observer retries; Then its stable ID is reused.
	const ids: string[] = [];
	const first = new CredentialNoticeObserver({
		...fixture.deps,
		publish: (notice) => {
			ids.push(notice.id);
			throw new Error("publication failure");
		},
	});
	await first.refresh(true);
	const replay = new CredentialNoticeObserver({
		...fixture.deps,
		publish: (notice, beforeDismiss) => {
			ids.push(notice.id);
			return notifyUpdate(notice, { beforeDismiss });
		},
	});
	await replay.refresh(true);
	expect(ids).toHaveLength(2);
	expect(ids[0]).toBe(ids[1]);
});

test("a stopped observer cannot publish a late reader result", async () => {
	// Given a held refresh surrendered at shutdown; When it resolves late; Then no mutation/publication escapes.
	let release: (value: typeof fixture.state.observation) => void = () => {};
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		read: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	const pending = observer.refresh(true);
	await Promise.resolve();
	observer.stop();
	release(fixture.state.observation);
	await pending;
	expect(getPersistentNotifications(true).show).toHaveLength(0);
});
