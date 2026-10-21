/// <reference types="bun" />
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { logger } from "../helpers/logger.ts";
import { credentialObserverFixture } from "./helpers/credential-observer-fixture.ts";

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
