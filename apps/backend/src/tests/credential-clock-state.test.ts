/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { CredentialNoticeLedger } from "../modules/system/update-orchestrator/credential-ledger.ts";
import { credentialLedgerSchema } from "../modules/system/update-orchestrator/credential-ledger-state.ts";
import { CredentialNoticeObserver } from "../modules/system/update-orchestrator/credential-notice-observer.ts";
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

test("details immediately refuses a backward step before another observer tick", async () => {
	// Given known expiring evidence at the recorded time.
	await fixture.observer.refresh(true);
	// When time reverses without refreshing or mutating the ledger.
	fixture.state.now = 0;
	// Then GET cannot report valid and cannot publish any additional intent.
	expect(fixture.observer.details()).toEqual({
		expiresAt: null,
		state: "unavailable",
	});
});

test("acknowledgement checkpoints latest in-process observation for a new observer", async () => {
	// Given an active warning followed by a no-write minute observation.
	await fixture.observer.refresh(true);
	fixture.state.now += 60_000;
	await fixture.observer.refresh();
	const latest = fixture.state.now;
	if (fixture.state.observation.kind !== "known")
		throw new Error("fixture unknown");
	const intent = fixture.ledger.observe(
		fixture.state.observation,
		latest,
	).current;
	if (!intent) throw new Error("fixture intent missing");
	fixture.ledger.acknowledge(intent);
	// When a new observer reads the same certificate at the earlier clock.
	fixture.state.now--;
	const restarted = new CredentialNoticeObserver({
		...fixture.deps,
		ledger: new CredentialNoticeLedger({ path: fixture.path }),
	});
	await restarted.refresh(true);
	// Then the durable timestamp prevents a healthy claim even without an active notice.
	const stored = credentialLedgerSchema.parse(
		JSON.parse(await readFile(fixture.path, "utf8")),
	);
	expect(stored.latestObservedAt).toBe(latest);
	expect(restarted.details().state).toBe("unavailable");
});

test("schema-1 active history retains identity and derives a conservative clock floor", async () => {
	// Given existing strict schema-1 bytes with an active 30-day threshold.
	const id = "a2173c5b-2f8e-4c6b-8897-e20df8171d50";
	await writeFile(
		fixture.path,
		JSON.stringify({
			schema: 1,
			currentGeneration: id,
			generations: [
				{
					id,
					digest: "a".repeat(64),
					expiresAt: 180 * DAY,
					notices: { "90": "superseded", "30": "active" },
				},
			],
		}),
		{ mode: 0o600 },
	);
	fixture.state.now = 0;
	const published: string[] = [];
	const observer = new CredentialNoticeObserver({
		...fixture.deps,
		publish: (notice) => {
			published.push(notice.id);
			return true;
		},
	});
	// When the upgraded observer reloads old history before its recorded crossing.
	await observer.refresh(true);
	// Then history survives conversion without inventing valid status.
	expect(published).toEqual([`${id}:30`]);
	expect(observer.details().state).toBe("unavailable");
});
