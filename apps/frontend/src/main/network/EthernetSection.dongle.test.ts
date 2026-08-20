// @vitest-environment jsdom
/**
 * EthernetSection — isolated-dongle row (modem-stack Phase B, todo 19).
 *
 * A `dg<N>h` row is the HOST side of a veth pair into a claimed router-mode USB
 * dongle's own network namespace. The backend stamps `dongle: {slot, state}` on
 * such a row and additionally UNIONS a metadata-only row for a dongle whose veth
 * is still gated (no `ip`, `enabled: false`, zero counters). Both shapes land in
 * `wiredEntries`, so both are rendered here.
 *
 * Two things are proven:
 *
 *   1. All THREE marker states render honestly — the "Cellular dongle · isolated"
 *      badge, a state badge whose WORD (not merely its colour) names `up` /
 *      `acquiring` / `down`, and — for the two states whose veth is
 *      administratively down and address-less, and therefore structurally cannot
 *      carry bonded traffic — a DISABLED BondToggle whose reason is reachable
 *      both as the control's accessible name and as on-screen text (a kiosk
 *      touchscreen cannot hover to reveal a tooltip).
 *   2. A plain, unmarked wired row is UNCHANGED by all of the above.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { elementShape, shapeOf } from "./__fixtures__/element-shape";
import plainRowGolden from "./__fixtures__/ethernet-plain-row.shape.txt?raw";
import EthernetSection from "./EthernetSection.svelte";

// EthernetSection mounts BondToggle, which imports the RPC client + subscriptions.
// Stub both so the unit stays hermetic — mirrors EthernetSection.linklocal.test.ts.
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const PLAIN_ROW: NetifEntry = { tp: 1234, enabled: true, ip: "192.168.1.2" };

function renderRows(rows: [string, NetifEntry][]) {
	return render(EthernetSection, {
		props: {
			wiredEntries: rows,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

// A LIVE dongle: its veth carries an address and is genuinely bondable.
function liveDongleRow(state: "up"): [string, NetifEntry] {
	return [
		"dg0h",
		{ tp: 4096, enabled: true, ip: "10.208.0.1", dongle: { slot: 0, state } },
	];
}

// A GATED dongle: the wire-projection union row the backend synthesizes because
// an acquiring/down dongle's veth is not RUNNING and never enters the netif map.
function gatedDongleRow(
	state: "acquiring" | "down",
	slot = 1,
): [string, NetifEntry] {
	return [`dg${slot}h`, { tp: 0, enabled: false, dongle: { slot, state } }];
}

describe("EthernetSection — isolated-dongle row", () => {
	it("renders the isolated badge + an 'up' state on a live dongle, toggle still live", () => {
		const { getByTestId } = renderRows([liveDongleRow("up")]);

		const badge = getByTestId("netif-dongle");
		expect(badge.textContent).toContain("Cellular dongle · isolated");
		// The isolation concept is explained where the claim is made.
		expect(badge.getAttribute("title")).toContain("network namespace");
		expect(badge.getAttribute("data-dongle-slot")).toBe("0");

		const state = getByTestId("netif-dongle-state");
		expect(state.getAttribute("data-dongle-state")).toBe("up");
		// The WORD carries the state; colour only reinforces it.
		expect(state.textContent?.trim()).toBe("Up");

		// An `up` dongle's veth has an address, so it IS bondable — no false block.
		const toggle = getByTestId("bond-toggle-dg0h");
		expect(toggle.hasAttribute("disabled")).toBe(false);
		expect(toggle.getAttribute("data-disabled")).toBeNull();
		expect(
			document.querySelector('[data-testid="netif-dongle-blocked-hint"]'),
		).toBeNull();
	});

	for (const { state, word, reason } of [
		{
			state: "acquiring" as const,
			word: "Acquiring",
			reason: "Still getting a connection",
		},
		{ state: "down" as const, word: "Down", reason: "No connection" },
	]) {
		it(`renders '${state}' with a DISABLED toggle whose reason is stated, never bare`, () => {
			const { getByTestId } = renderRows([gatedDongleRow(state)]);

			expect(getByTestId("netif-dongle").textContent).toContain(
				"Cellular dongle · isolated",
			);

			const badge = getByTestId("netif-dongle-state");
			expect(badge.getAttribute("data-dongle-state")).toBe(state);
			expect(badge.textContent?.trim()).toBe(word);

			const toggle = getByTestId("bond-toggle-dg1h");
			expect(toggle.getAttribute("data-disabled")).not.toBeNull();
			// The reason is the control's ACCESSIBLE NAME (tooltip + aria-label)…
			expect(toggle.getAttribute("aria-label")).toContain(reason);
			expect(toggle.getAttribute("aria-label")).toContain("bonding pool");
			// …AND is on screen, because a touchscreen cannot hover to reveal it.
			const hint = getByTestId("netif-dongle-blocked-hint");
			expect(hint.textContent).toContain(reason);
			expect(hint.textContent).toContain("bonding pool");
		});
	}

	it("marks each state with its own glyph, so colour is never the only signal", () => {
		const glyphs = (["up", "acquiring", "down"] as const).map((state) => {
			const { getByTestId, unmount } = renderRows([
				state === "up" ? liveDongleRow("up") : gatedDongleRow(state),
			]);
			const cls = getByTestId("netif-dongle-state")
				.querySelector("svg")
				?.getAttribute("class");
			unmount();
			return cls ?? "";
		});
		expect(glyphs.every((cls) => cls !== "")).toBe(true);
		expect(new Set(glyphs).size).toBe(3);
	});

	it("renders NOTHING dongle-specific for an unmarked wired row", () => {
		const { queryByTestId } = renderRows([["eth0", PLAIN_ROW]]);

		expect(queryByTestId("netif-dongle")).toBeNull();
		expect(queryByTestId("netif-dongle-state")).toBeNull();
		expect(queryByTestId("netif-dongle-blocked-hint")).toBeNull();
	});

	// The regression lock for the COMMON case. The golden was captured from the
	// tree at `ab882cd9` (todo 18's tip, i.e. before this change) and is compared
	// element-for-element, attribute-for-attribute, text-for-text.
	//
	// RE-CAPTURED ONCE, in todo 43, for a deliberate responsive fix — the row's
	// state dot gained `self-start mt-1.5` and its text column gained `basis-72`.
	// Both were measured, not guessed: once a row carries several lines a centred
	// dot floats away from the name it reports on, and with `flex-1` alone the
	// control cluster never wraps below ~500px, so it starved the text column into
	// one word per line with the IP running under the toggle. The diff against the
	// previous golden was exactly those two class lists and nothing else, which is
	// what this lock exists to prove. Re-capture it again only for a change you
	// can describe in the same terms.
	it("renders a plain wired row identically to before the dongle change", () => {
		const { container } = renderRows([["eth0", PLAIN_ROW]]);
		expect(shapeOf(container)).toBe(plainRowGolden.trimEnd());
	});

	// A marked row must not leak into its neighbours: the eth0 row rendered
	// BESIDE a dongle row is identical to the eth0 row rendered on its own.
	it("keeps a plain row unchanged when a dongle row shares the section", () => {
		const alone = renderRows([["eth0", PLAIN_ROW]]);
		const aloneRow = elementShape(
			alone.container.querySelector(".divide-y > div") as Element,
		);
		alone.unmount();

		const mixed = renderRows([
			["eth0", PLAIN_ROW],
			gatedDongleRow("acquiring"),
		]);
		const rows = mixed.container.querySelectorAll(".divide-y > div");
		expect(rows.length).toBe(2);
		expect(elementShape(rows[0] as Element)).toBe(aloneRow);
	});
});
