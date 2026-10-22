/// <reference types="bun" />
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { logger } from "../helpers/logger.ts";
import { readCredentialExpiry } from "../modules/system/update-orchestrator/credential-expiry.ts";
import { CredentialNoticeObserver } from "../modules/system/update-orchestrator/credential-notice-observer.ts";
import {
	isNotificationDismissed,
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	credentialObserverFixture,
	CREDENTIAL_DAY as DAY,
} from "./helpers/credential-observer-fixture.ts";
import { DISMISSAL_CHURN_TIMEOUT_MS } from "./helpers/notification-churn-budget.ts";

let fixture: Awaited<ReturnType<typeof credentialObserverFixture>>;
let previousPath: string | undefined;
beforeEach(async () => {
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	fixture = await credentialObserverFixture();
	previousPath = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = `${fixture.root}/dismissals.json`;
	resetDismissalStoreForTests();
});
afterEach(async () => {
	fixture.observer.stop();
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	if (previousPath === undefined) delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = previousPath;
	resetDismissalStoreForTests();
	await fixture.cleanup();
});

test("startup rehydrates undismissed active notice with the same name", async () => {
	// Given persisted active intent and an empty notification map after restart; When refreshed; Then restore the same logical notice.
	await fixture.observer.refresh(true);
	const notice = getPersistentNotifications(true).show[0];
	if (!notice) throw new Error("fixture notice missing");
	notificationRemove(notice.name);
	await new CredentialNoticeObserver(fixture.deps).refresh(true);
	expect(
		getPersistentNotifications(true).show.map((item) => item.name),
	).toEqual([notice.name]);
});

test(
	"shared durable dismissal is mirrored before rehydration",
	async () => {
		// Given an older shared dismissal for an active intent; When a fresh observer sees it; Then persist a dedicated acknowledgement.
		await fixture.observer.refresh(true);
		const notice = getPersistentNotifications(true).show[0];
		if (!notice) throw new Error("fixture notice missing");
		recordNotificationDismissal(notice.name);
		const observer = new CredentialNoticeObserver({
			...fixture.deps,
			dismissed: isNotificationDismissed,
			clear: () => notificationRemove(notice.name),
		});
		await observer.refresh(true);
		for (let index = 0; index < 300; index++)
			recordNotificationDismissal(`ordinary-${index}`);
		await new CredentialNoticeObserver(fixture.deps).refresh(true);
		expect(getPersistentNotifications(true).show).toHaveLength(0);
	},
	DISMISSAL_CHURN_TIMEOUT_MS,
);

test("unreadable replacement is unknown and never retires an established warning as renewed", async () => {
	// Given an established warning; When a replacement cannot be read; Then retain the warning but project unknown.
	await fixture.observer.refresh(true);
	const names = getPersistentNotifications(true).show.map((item) => item.name);
	fixture.state.observation = { kind: "unavailable", reason: "read-failed" };
	await fixture.observer.refresh(true);
	expect(fixture.observer.details()).toEqual({
		expiresAt: null,
		state: "unavailable",
	});
	expect(
		getPersistentNotifications(true).show.map((item) => item.name),
	).toEqual(names);
});

test("corrupt journal cannot become a known healthy details block or a warning", async () => {
	// Given unknown persisted authority; When otherwise healthy certificate evidence arrives; Then journal uncertainty remains unavailable.
	await writeFile(fixture.path, '{"schema":77}');
	await fixture.observer.refresh(true);
	expect(fixture.observer.details()).toEqual({
		expiresAt: null,
		state: "unavailable",
	});
	expect(getPersistentNotifications(true).show).toHaveLength(0);
});

test("forced refresh bypasses the public-read cache but ordinary minute ticks reuse it", async () => {
	// Given an established cached reading; When a minute tick then forced replacement refresh run; Then only the explicit refresh rereads.
	await fixture.observer.refresh(true);
	fixture.state.now += 60_000;
	await fixture.observer.refresh();
	expect(fixture.state.reads).toBe(1);
	await fixture.observer.refresh(true);
	expect(fixture.state.reads).toBe(2);
});

test.each([
	{ now: 0, state: "valid" },
	{ now: 100 * DAY, state: "expiring" },
	{ now: 180 * DAY, state: "expired" },
] as const)(
	"details evaluates cached certificate as $state without emitting from GET",
	async ({ now, state }) => {
		// Given known public evidence; When the cached projection is read; Then state follows absolute expiry without a new notice event.
		fixture.state.now = now;
		await fixture.observer.refresh(true);
		const count = fixture.published.length;
		expect(fixture.observer.details()).toEqual({ expiresAt: 180 * DAY, state });
		expect(fixture.published).toHaveLength(count);
	},
);

test("secret-looking parser/filesystem errors never reach captured logs or wire projection", async () => {
	// Given distinctive raw-error and digest sentinels; When observed; Then logs/notifications/details contain only safe fields.
	const captured: unknown[][] = [];
	const log = spyOn(logger, "warn").mockImplementation((...args) => {
		captured.push(args);
		return logger;
	});
	try {
		const observer = new CredentialNoticeObserver({
			...fixture.deps,
			read: () =>
				readCredentialExpiry({
					exists: () => true,
					readPublic: () => {
						throw new Error(
							"-----BEGIN CERTIFICATE----- private-subject /fleet/client.key digest-sentinel",
						);
					},
				}),
		});
		await observer.refresh(true);
		const output = JSON.stringify({
			captured,
			details: observer.details(),
			notifications: getPersistentNotifications(true),
		});
		for (const sentinel of [
			"-----BEGIN CERTIFICATE-----",
			"client.key",
			"private-subject",
			"digest-sentinel",
			"a".repeat(64),
		])
			expect(output).not.toContain(sentinel);
	} finally {
		log.mockRestore();
	}
});
