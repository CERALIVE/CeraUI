import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	announceOsStageSettlement,
	clearOsStageNotices,
	notifyUpdate,
	OS_STAGE_NOTICE_KINDS,
} from "../modules/system/update-orchestrator/notifications.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const CANDIDATE = "c0ffee0000000001";
const OTHER = "c0ffee0000000002";

function updateNotices(): Array<{
	name: string;
	key?: string;
	params?: Record<string, unknown>;
}> {
	return getPersistentNotifications(true)
		.show.filter((notice) => notice.name.startsWith("update:"))
		.map((notice) => ({
			name: notice.name,
			...(notice.key !== undefined ? { key: notice.key } : {}),
			...(notice.params !== undefined ? { params: notice.params } : {}),
		}));
}

function captureFrames(run: () => void): string[] {
	const sink: string[] = [];
	const client = {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
	addClient(client);
	try {
		run();
	} finally {
		removeClient(client);
	}
	return sink.flatMap((raw) => {
		const frame = JSON.parse(raw) as {
			notification?: { remove?: Array<{ id: string }> };
		};
		return (frame.notification?.remove ?? []).map((entry) => entry.id);
	});
}

function clearUpdateNotices(): void {
	for (const notice of updateNotices()) notificationRemove(notice.name);
}

beforeEach(clearUpdateNotices);
afterEach(clearUpdateNotices);

describe("OS staging settlement notices", () => {
	test("a settlement raises exactly one notice for the exact candidate, carrying only the version", () => {
		expect(
			announceOsStageSettlement("os-stage-retry", CANDIDATE, "2026.10.0"),
		).toBe(true);
		expect(updateNotices()).toEqual([
			{
				name: `update:os-stage-retry:${CANDIDATE}`,
				key: "notifications.updateSystemStageRetry",
				params: { version: "2026.10.0" },
			},
		]);
	});

	test("an operator-only settlement replaces the candidate's retry notice", () => {
		announceOsStageSettlement("os-stage-retry", CANDIDATE, "2026.10.0");
		const removed = captureFrames(() => {
			announceOsStageSettlement("os-stage-operator", CANDIDATE, "2026.10.0");
		});
		expect(removed).toEqual([`update:os-stage-retry:${CANDIDATE}`]);
		expect(updateNotices().map((notice) => notice.name)).toEqual([
			`update:os-stage-operator:${CANDIDATE}`,
		]);
	});

	test("successful staging clears the candidate's notice and publishes the removal", () => {
		announceOsStageSettlement("os-stage-unresolved", CANDIDATE, "2026.10.0");
		const removed = captureFrames(() => clearOsStageNotices(CANDIDATE));
		expect(removed).toEqual([`update:os-stage-unresolved:${CANDIDATE}`]);
		expect(updateNotices()).toEqual([]);
	});

	test("clearing one candidate leaves other candidates and other update notices alone", () => {
		announceOsStageSettlement("os-stage-retry", CANDIDATE, "2026.10.0");
		announceOsStageSettlement("os-stage-operator", OTHER, "2026.10.1");
		notifyUpdate({ kind: "os-staged", id: "2026.10.1", version: "2026.10.1" });
		notifyUpdate({ kind: "refused", id: "packages:x", reason: "x" });
		const removed = captureFrames(() => clearOsStageNotices(CANDIDATE));
		expect(removed).toEqual([`update:os-stage-retry:${CANDIDATE}`]);
		expect(
			updateNotices()
				.map((notice) => notice.name)
				.sort(),
		).toEqual(
			[
				`update:os-stage-operator:${OTHER}`,
				"update:os-staged:2026.10.1",
				"update:refused:packages:x",
			].sort(),
		);
	});

	test("clearing a candidate with no notice publishes nothing", () => {
		expect(captureFrames(() => clearOsStageNotices(CANDIDATE))).toEqual([]);
	});

	test("each notice kind has its own presentation key", () => {
		const keys = OS_STAGE_NOTICE_KINDS.map((kind) => {
			announceOsStageSettlement(kind, CANDIDATE, "2026.10.0");
			return updateNotices()[0]?.key;
		});
		expect(keys).toEqual([
			"notifications.updateSystemStageRetry",
			"notifications.updateSystemStageOperator",
			"notifications.updateSystemStageUnresolved",
		]);
	});
});
