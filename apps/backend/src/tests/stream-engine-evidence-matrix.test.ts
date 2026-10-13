import { expect, test } from "bun:test";
import {
	evidenceHarness,
	flushEvidence,
} from "./helpers/stream-engine-evidence.ts";

for (const engine of ["idle", "streaming"] as const) {
	for (const delivery of ["idle", "streaming", "silence"] as const) {
		test(`independent probe matrix engine=${engine} delivery=${delivery}`, async () => {
			// Given independent engine truth and a current real factory/backend probe.
			const h = evidenceHarness();
			h.setEngine(engine);
			try {
				const query = h.session.reconcile();
				await flushEvidence();
				// When delivery is affirmative, it carries a new engine fact; silence carries none.
				if (delivery === "silence")
					for (const callback of [...h.timers.values()]) callback();
				else {
					h.setEngine(delivery);
					h.status(0, delivery === "streaming");
				}
				await query;
				// Then the expected truth derives only from the delivered evidence, not a transition guard.
				expect(h.view().engine).toBe(
					delivery === "silence" ? engine : delivery,
				);
				expect(h.view().state).toBe(
					delivery === "silence" ? "reconciling" : delivery,
				);
				expect(h.view().marked).toBe(delivery !== "idle");
				expect(h.session.streamLiveness()).toBe(
					delivery === "silence" ? "unknown" : delivery,
				);
			} finally {
				h.dispose();
			}
		});
	}
}

for (const reply of ["idle", "streaming", "silence"] as const) {
	test(`held obsolete query matrix reply=${reply} cannot overwrite replacement`, async () => {
		// Given a query held behind subscription while an operator Stop supersedes it.
		const h = evidenceHarness();
		const subscribed = Promise.withResolvers<void>();
		h.holdSubscribe(subscribed.promise);
		try {
			const query = h.session.reconcile();
			await flushEvidence();
			await h.session.stop("operator");
			await h.start();
			// When the old reply/event or silence arrives after the independent engine is live again.
			if (reply !== "silence") h.status(0, reply === "streaming");
			subscribed.resolve();
			await flushEvidence();
			for (const callback of [...h.timers.values()]) callback();
			await query;
			// Then obsolete observation has no authority over the new client/generation.
			expect(h.view()).toMatchObject({
				engine: "streaming",
				state: "streaming",
				live: true,
				marked: true,
				generation: 1,
			});
			expect(h.clients[0]?.calls).toContain("close");
		} finally {
			h.dispose();
		}
	});
}

for (const rollbackAcknowledged of [true, false]) {
	test(`independent launch matrix rollbackAcknowledged=${rollbackAcknowledged}`, async () => {
		// Given a Start that takes effect before its reply is lost.
		const h = evidenceHarness();
		h.failStart();
		if (!rollbackAcknowledged) h.failStop();
		try {
			// When rollback either affirms physical idle or supplies no confirmation.
			const outcome = await h.start();
			// Then both retain the original failure, but only the ack grants idle.
			expect(outcome).toMatchObject({
				result: "failed",
				failure: { phase: "start-rpc", class: "start_timeout" },
			});
			expect(h.view().engine).toBe(rollbackAcknowledged ? "idle" : "streaming");
			expect(h.view().state).toBe(
				rollbackAcknowledged ? "idle" : "reconciling",
			);
			expect(h.view().marked).toBe(!rollbackAcknowledged);
		} finally {
			h.dispose();
		}
	});
}
