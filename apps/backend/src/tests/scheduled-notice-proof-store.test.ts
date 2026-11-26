import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEventsDir } from "../modules/events/store.ts";
import {
	compactId,
	readCompactOffers,
	rememberCompactOffer,
} from "../modules/system/update-orchestrator/package-notice-proofs.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";

function entry(version: number) {
	const offer = Array.from(
		{ length: 40 },
		(_, index) => `private-retirement-fixture-package-${index}=${version}`,
	)
		.sort()
		.join(",");
	return { id: compactId(offer), offer };
}

test("the private file replaces only an out-of-window entry and refuses an invalid write", () => {
	const state = join(resolveEventsDir(), "../update-state");
	const path = join(state, "scheduled-package-notices.json");
	mkdirSync(state, { recursive: true });
	setOrchestratorStateFilePathForTest(join(state, "agent.json"));
	try {
		const oldest = entry(1);
		const outsideWindow = entry(2);
		const more = Array.from({ length: 31 }, (_, index) => entry(index + 3));
		const eligible = [oldest, ...more];
		const incoming = entry(34);
		writeFileSync(
			path,
			JSON.stringify({ schema: 1, offers: [oldest, outsideWindow, ...more] }),
			{ mode: 0o600 },
		);

		const announced = () => new Set(eligible.map(({ id }) => id));
		rememberCompactOffer(incoming.id, incoming.offer, announced);
		expect([...readCompactOffers()]).toEqual(
			[...eligible, incoming].map(({ id, offer }) => [id, offer]),
		);

		const saved = readFileSync(path, "utf8");
		expect(() =>
			rememberCompactOffer(outsideWindow.id, incoming.offer, announced),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(saved);
	} finally {
		setOrchestratorStateFilePathForTest(null);
	}
});
