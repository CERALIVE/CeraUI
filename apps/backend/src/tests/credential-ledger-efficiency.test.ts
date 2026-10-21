/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CredentialNoticeLedger } from "../modules/system/update-orchestrator/credential-ledger.ts";
import { saveCredentialLedger } from "../modules/system/update-orchestrator/credential-ledger-io.ts";
import { CredentialNoticeObserver } from "../modules/system/update-orchestrator/credential-notice-observer.ts";
import { credentialObserverFixture } from "./helpers/credential-observer-fixture.ts";

let fixture: Awaited<ReturnType<typeof credentialObserverFixture>>;
beforeEach(async () => {
	fixture = await credentialObserverFixture({ publish: () => true });
});
afterEach(async () => {
	await fixture.cleanup();
});

test("active minute observations do not rewrite or resync unchanged ledger", async () => {
	// Given a durably active warning and counted real writes/parent acknowledgements.
	let writes = 0;
	let syncs = 0;
	const ledger = new CredentialNoticeLedger({
		path: fixture.path,
		write: (path, contents) => {
			writes++;
			saveCredentialLedger(path, contents);
		},
		syncParent: () => {
			syncs++;
		},
	});
	const observer = new CredentialNoticeObserver({ ...fixture.deps, ledger });
	await observer.refresh(true);
	const baseline = { writes, syncs };
	// When an hour passes without a new threshold, dismissal or rotation.
	for (let minute = 0; minute < 60; minute++) {
		fixture.state.now += 60_000;
		await observer.refresh();
	}
	// Then unchanged state incurs no write or directory acknowledgement.
	expect({ writes, syncs }).toEqual(baseline);
});
