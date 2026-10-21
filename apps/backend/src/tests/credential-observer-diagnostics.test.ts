/// <reference types="bun" />
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { logger } from "../helpers/logger.ts";
import { CredentialNoticeObserver } from "../modules/system/update-orchestrator/credential-notice-observer.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	credentialObserverFixture,
	CREDENTIAL_DAY as DAY,
} from "./helpers/credential-observer-fixture.ts";

let fixture: Awaited<ReturnType<typeof credentialObserverFixture>>;
beforeEach(async () => {
	fixture = await credentialObserverFixture({ publish: () => true });
});
afterEach(async () => {
	await fixture.cleanup();
});

test("reader fault logs only closed reason once per change and can recur after recovery", async () => {
	// Given a repeated reader fault and the production logger captured at its boundary.
	const captured: unknown[][] = [];
	const log = spyOn(logger, "warn").mockImplementation((...args) => {
		captured.push(args);
		return logger;
	});
	try {
		fixture.state.observation = {
			kind: "unavailable",
			reason: "metadata-mismatch",
		};
		// When the same fault repeats, changes reason, recovers, then recurs.
		await fixture.observer.refresh(true);
		await fixture.observer.refresh(true);
		fixture.state.observation = { kind: "unavailable", reason: "read-failed" };
		await fixture.observer.refresh(true);
		fixture.state.observation = {
			kind: "known",
			expiresAt: 180 * 86_400_000,
			digest: "a".repeat(64),
		};
		await fixture.observer.refresh(true);
		fixture.state.observation = { kind: "unavailable", reason: "read-failed" };
		await fixture.observer.refresh(true);
		// Then one bounded message per fault change contains no raw certificate identity.
		expect(captured).toEqual([
			[
				"update-orchestrator: credential observation deferred",
				{ reason: "reader-metadata-mismatch" },
			],
			[
				"update-orchestrator: credential observation deferred",
				{ reason: "reader-read-failed" },
			],
			[
				"update-orchestrator: credential observation deferred",
				{ reason: "reader-read-failed" },
			],
		]);
	} finally {
		log.mockRestore();
	}
});

test("refresh isolates a throwing diagnostic logger and recovers without exposing its error", async () => {
	// Given a faulty diagnostic transport and real notice publication.
	const pem = "-----BEGIN PRIVATE KEY-----";
	const keyPath = "/etc/apt/certs/client.key";
	const log = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error(`${pem} ${keyPath}`);
	});
	const rejections: unknown[] = [];
	const onRejection = (error: unknown) => {
		rejections.push(error);
	};
	const names: string[] = [];
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		publish: (notice, beforeDismiss) => {
			names.push(`update:${notice.kind}:${notice.id}`);
			return notifyUpdate(notice, { beforeDismiss });
		},
	});
	process.on("unhandledRejection", onRejection);
	try {
		// When a reader fault repeats, then the next healthy observation arrives.
		fixture.state.observation = { kind: "unavailable", reason: "read-failed" };
		for (let tick = 0; tick < 5; tick++) {
			fixture.state.now += 61_000;
			await expect(observer.refresh()).resolves.toBeUndefined();
		}
		const faulted = observer.details();
		const faultCalls = log.mock.calls.length;
		const expiresAt = fixture.state.now + 20 * DAY;
		fixture.state.observation = {
			kind: "known",
			expiresAt,
			digest: "a".repeat(64),
		};
		await expect(observer.refresh(true)).resolves.toBeUndefined();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const notices = getPersistentNotifications(true).show.filter((notice) =>
			names.includes(notice.name),
		);
		// Then the flight stayed isolated, recovered, and published only safe fields.
		expect(faultCalls).toBe(1);
		expect(faulted).toEqual({ expiresAt: null, state: "unavailable" });
		expect(observer.details()).toEqual({ expiresAt, state: "expiring" });
		expect(rejections).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			key: "notifications.updateCredentialsExpiring",
			params: { days: 30 },
		});
		const payload = JSON.stringify(
			notices.map(({ name, params }) => ({ name, params })),
		);
		expect(payload).not.toContain(pem);
		expect(payload).not.toContain(keyPath);
	} finally {
		observer.stop();
		process.off("unhandledRejection", onRejection);
		log.mockRestore();
		for (const name of names) notificationRemove(name);
	}
});

test("corrupt ledger logs one closed fault without repeated-tick spam", async () => {
	// Given unknown ledger bytes containing a private-looking sentinel.
	await writeFile(
		fixture.path,
		"-----BEGIN CERTIFICATE----- /client.key digest-sentinel",
	);
	const captured: unknown[][] = [];
	const log = spyOn(logger, "warn").mockImplementation((...args) => {
		captured.push(args);
		return logger;
	});
	try {
		// When reconciliation repeatedly refuses those bytes.
		await fixture.observer.refresh(true);
		await fixture.observer.refresh(true);
		// Then the diagnostic is bounded and carries only the closed ledger code.
		expect(captured).toEqual([
			[
				"update-orchestrator: credential observation deferred",
				{ reason: "ledger-unavailable" },
			],
		]);
		expect(fixture.observer.details().state).toBe("unavailable");
	} finally {
		log.mockRestore();
	}
});
