// @vitest-environment jsdom
/**
 * CollisionBands — the (ip,iface) bind-map degradation band (todo 12).
 *
 * The band is DRIVEN by the one normalized disposition the backend publishes
 * and never inferred from an absent field. `mapped` is the only silent state;
 * every other disposition says something different about what is bonded, and
 * the sender's machine-readable reason is resolved to copy rather than rendered
 * raw.
 */

import type { BondMapping } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import CollisionBands from "./CollisionBands.svelte";

function mount(bondMapping: BondMapping | null) {
	return render(CollisionBands, { props: { netif: {}, bondMapping } });
}

const COLLISION: BondMapping = {
	state: "degraded",
	reason: "unsupported",
	disposition: "startup_collision_excluded",
	collisions: [
		{ ip: "192.168.8.100", effective_index: 0, excluded_indices: [1] },
	],
	source: "writer",
};

describe("CollisionBands — bind-map disposition band (todo 12)", () => {
	it("says NOTHING for a fully mapped bond", () => {
		const { queryByTestId } = mount({
			state: "active",
			disposition: "mapped",
			source: "writer",
		});
		expect(queryByTestId("bond-mapping-warning")).toBeNull();
	});

	it("says NOTHING when no bond is described at all", () => {
		expect(mount(null).queryByTestId("bond-mapping-warning")).toBeNull();
	});

	it("names the colliding address and its LINE positions, 1-based", () => {
		const { queryByTestId } = mount(COLLISION);

		const band = queryByTestId("bond-mapping-warning");
		expect(band, "the degradation must be operator-visible").not.toBeNull();
		expect(band?.dataset.disposition).toBe("startup_collision_excluded");
		expect(band?.className).toContain("status-warning");

		const group = queryByTestId("bond-mapping-collision");
		expect(group?.dataset.ip).toBe("192.168.8.100");
		expect(group?.textContent).toContain("192.168.8.100");
		expect(group?.textContent).toContain("line 1 is carrying it");
		expect(group?.textContent).toContain("line 2 excluded");
	});

	it("renders the sender's reason as COPY, never as its raw token", () => {
		const { queryByTestId } = mount(COLLISION);

		const reason = queryByTestId("bond-mapping-reason");
		expect(reason?.textContent).toContain(
			"The installed sender doesn't support per-interface mapping.",
		);
		expect(reason?.textContent).not.toContain("unsupported");
	});

	it("a retained mapping says both links are still running", () => {
		const { queryByTestId } = mount({
			state: "degraded",
			reason: "hash_mismatch",
			disposition: "retained_last_valid",
			source: "sender",
		});

		const band = queryByTestId("bond-mapping-warning");
		expect(queryByTestId("bond-mapping-title")?.textContent?.trim()).toBe(
			"Link mapping degraded",
		);
		expect(band?.textContent).toContain(
			"still running on the last valid mapping",
		);
		expect(queryByTestId("bond-mapping-collision")).toBeNull();
	});

	it("a legacy-unique bond states what IS bonded, not that nothing is", () => {
		const { queryByTestId } = mount({
			state: "degraded",
			reason: "missing_file",
			disposition: "legacy_unique_only",
			source: "writer",
		});

		const band = queryByTestId("bond-mapping-warning");
		expect(band?.textContent).toContain(
			"Every link with its own address is bonded normally",
		);
		// The honest replacement for "these links can't be used".
		expect(band?.textContent).not.toContain("can't be used");
	});

	it("never leaks a machine token or an unresolved message key", () => {
		for (const reason of [
			"hash_mismatch",
			"malformed",
			"unknown_iface",
			"retry_exhausted",
			"missing_file",
			"unreadable",
			"unsupported",
		] as const) {
			const { queryByTestId, unmount } = mount({
				state: "degraded",
				reason,
				disposition: "legacy_unique_only",
				source: "sender",
			});
			const text = queryByTestId("bond-mapping-warning")?.textContent ?? "";
			expect(text).not.toContain(reason);
			expect(text).not.toContain("network.collision.");
			unmount();
		}
	});
});
