import type {
	Modem,
	ModemBandsOutput,
	ModemBandsRefusal,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import type { CapabilityView } from "$lib/modem/sections";
import type { FiveGView } from "./modem-five-g";
import {
	BAND_NOT_ESTABLISHED_KEY,
	bandCapabilityView,
	fiveGCapabilityView,
	NETWORK_TYPE_UNKNOWN_KEY,
	networkModeCapabilityView,
	RADIO_NO_SIM_REASON_KEY,
} from "./modem-radio-selectors";

/*
  THE ONE INVARIANT THIS WHOLE MODULE EXISTS FOR: `unknown` and `absent` are
  different answers, and the difference is observable. `absent` carries no
  reason because it renders nothing; `unknown` MUST carry one, because a status
  line with no sentence in it is the silence this replaced.
*/
function expectWellFormed(view: CapabilityView): void {
	if (view.mode === "unknown" || view.mode === "blocked") {
		expect(view.reasonKey.length).toBeGreaterThan(0);
		expect(view.reasonKey.startsWith("network.")).toBe(true);
	} else {
		expect(Object.keys(view)).toEqual(["mode"]);
	}
}

const offered = (offerable: string[]): ModemBandsOutput => ({
	success: true,
	bands: {
		supported: ["eutran-1", "eutran-3", "ngran-78"],
		current: ["any"],
		offerable,
		unlocked: true,
	},
});

const refused = (error: ModemBandsRefusal): ModemBandsOutput => ({
	success: false,
	error,
});

describe("the band lock", () => {
	/*
	  THE DEFECT, PINNED. `deriveBandOffer(undefined)` is `phase: "unknown"` —
	  "not asked yet, in flight, or the read THREW" — and the retired two-state
	  helper rendered that as `absent`, i.e. as a positive claim that this modem
	  has no bands. It is a read we could not complete, and it says so.
	*/
	it("a read that never answered is UNKNOWN with a reason, never absent", () => {
		const view = bandCapabilityView(undefined);

		expect(view).toEqual({
			mode: "unknown",
			reasonKey: BAND_NOT_ESTABLISHED_KEY,
		});
		expectWellFormed(view);
	});

	it("a failure the device did not explain is UNKNOWN, not a silent absence", () => {
		expect(bandCapabilityView({ success: false })).toEqual({
			mode: "unknown",
			reasonKey: BAND_NOT_ESTABLISHED_KEY,
		});
	});

	it("a certified set with something to offer is AVAILABLE", () => {
		expect(bandCapabilityView(offered(["eutran-3"]))).toEqual({
			mode: "available",
		});
	});

	/*
	  The device ANSWERED and named nothing selectable. That is a positive claim
	  about the hardware, so it is the one success shape that renders nothing.
	*/
	it("a certified set with nothing to offer is ABSENT", () => {
		expect(bandCapabilityView(offered([]))).toEqual({ mode: "absent" });
	});

	/*
	  The refusal table, row by row. `unsupported` is the ONLY one that is a
	  statement about the device; the rest are statements about a read or about a
	  gate this build controls, and neither may render as "your modem cannot".
	*/
	const REFUSALS: readonly {
		error: ModemBandsRefusal;
		mode: CapabilityView["mode"];
	}[] = [
		{ error: "unsupported", mode: "absent" },
		{ error: "uncertified", mode: "blocked" },
		{ error: "module_disabled", mode: "unknown" },
		{ error: "unknown_modem", mode: "unknown" },
		{ error: "read_failed", mode: "unknown" },
	];

	it.each(REFUSALS)("`$error` renders as $mode", ({ error, mode }) => {
		const view = bandCapabilityView(refused(error));

		expect(view.mode).toBe(mode);
		expectWellFormed(view);
		if (view.mode !== "absent" && view.mode !== "available") {
			expect(view.reasonKey).toBe(`network.modem.bands.reason.${error}`);
		}
	});

	/*
	  The task's own acceptance row, stated as its own test because it is a
	  CORRECTION rather than a preserved behaviour: modem-stack's
	  `band/certification.ts` refuses the WRITE with `band-certification-required`
	  on a SKU whose modem DID advertise bands. A capability that exists and is
	  refused right now is `blocked`; rendering it `absent` told the operator
	  their modem has none.
	*/
	it("an uncertified SKU is BLOCKED with the certification reason, not hidden", () => {
		expect(bandCapabilityView(refused("uncertified"))).toEqual({
			mode: "blocked",
			reasonKey: "network.modem.bands.reason.uncertified",
		});
	});

	it("unknown and absent are never the same answer for any input", () => {
		const seen = new Set(
			[
				undefined,
				{ success: false } satisfies ModemBandsOutput,
				offered(["eutran-3"]),
				offered([]),
				...REFUSALS.map((row) => refused(row.error)),
			].map((input) => bandCapabilityView(input).mode),
		);

		expect([...seen].sort()).toEqual([
			"absent",
			"available",
			"blocked",
			"unknown",
		]);
	});
});

describe("the network-mode selector", () => {
	const catalog = (supported: string[]): Modem["network_type"] => ({
		supported,
		active: supported[0] ?? null,
	});

	it("a modem that published no catalog at all is UNKNOWN", () => {
		const view = networkModeCapabilityView(undefined, false);

		expect(view).toEqual({
			mode: "unknown",
			reasonKey: NETWORK_TYPE_UNKNOWN_KEY,
		});
		expectWellFormed(view);
	});

	/*
	  It ANSWERED, and named nothing. The retired form rendered a dropdown that
	  opened onto "No networks found yet. Scan to search for operators." — copy
	  about operator scanning, in a control that picks a radio technology.
	*/
	it("a modem that answered with an empty catalog is ABSENT", () => {
		expect(networkModeCapabilityView(catalog([]), false)).toEqual({
			mode: "absent",
		});
	});

	/*
	  The `modems` broadcast is CAST, not parsed, so the schema's "required"
	  buys nothing at runtime. A block that arrived without its catalog used to
	  throw here and take the ENTIRE control plane down through the top-level
	  render boundary — a whole-UI crash from one absent sub-field.
	*/
	it("a network_type carrying NO catalog is UNKNOWN, and never throws", () => {
		const partial = { active: "4g" } as unknown as Modem["network_type"];

		let view: CapabilityView | undefined;
		expect(() => {
			view = networkModeCapabilityView(partial, false);
		}).not.toThrow();

		expect(view).toEqual({
			mode: "unknown",
			reasonKey: NETWORK_TYPE_UNKNOWN_KEY,
		});
	});

	it("a populated catalog with a card in the slot is AVAILABLE", () => {
		expect(networkModeCapabilityView(catalog(["4g", "5g"]), false)).toEqual({
			mode: "available",
		});
	});

	it("a populated catalog with no SIM is BLOCKED with its reason", () => {
		const view = networkModeCapabilityView(catalog(["4g", "5g"]), true);

		expect(view).toEqual({
			mode: "blocked",
			reasonKey: RADIO_NO_SIM_REASON_KEY,
		});
		expectWellFormed(view);
	});

	/*
	  The bench Fibocom FM350-GL advertises EXACTLY ONE combination
	  (`allowed: 2g, 3g, 4g, 5g; preferred: none`). One entry is a first-class
	  answer, not a degenerate one — the whole point of not inventing a second.
	*/
	it("a single advertised combination is AVAILABLE, not collapsed away", () => {
		expect(networkModeCapabilityView(catalog(["2g3g4g5g"]), false)).toEqual({
			mode: "available",
		});
	});

	it("an empty catalog is absent whether or not a SIM is present", () => {
		expect(networkModeCapabilityView(catalog([]), true)).toEqual({
			mode: "absent",
		});
	});
});

describe("the 5G preference", () => {
	const hidden: FiveGView = { kind: "hidden" };
	const advertised: FiveGView = {
		kind: "offered",
		options: [
			{
				preference: "prefer-5g",
				labelKey: "network.modem.fiveG.option.preferFiveG",
				descriptionKey: "network.modem.fiveG.description.preferFiveG",
				active: true,
			},
		],
		active: "prefer-5g",
		nrModeReasonKey: "network.modem.fiveG.nrMode.notExposed",
	};

	it("a published posture set is AVAILABLE", () => {
		expect(fiveGCapabilityView(advertised, "capable", false)).toEqual({
			mode: "available",
		});
	});

	it("a published posture set with no SIM is BLOCKED with its reason", () => {
		const view = fiveGCapabilityView(advertised, "capable", true);

		expect(view).toEqual({
			mode: "blocked",
			reasonKey: RADIO_NO_SIM_REASON_KEY,
		});
		expectWellFormed(view);
	});

	/*
	  The DEVICE's block outranks the claim it was derived from: the backend emits
	  it only where the ladder says the control may be offered, so a block that
	  arrived is stronger evidence than the matrix beside it. Re-deriving the gate
	  here could only ever disagree with the backend's.
	*/
	it("a published posture set is offered even where the claim disagrees", () => {
		for (const claim of [undefined, "unavailable", "implemented"] as const) {
			expect(fiveGCapabilityView(advertised, claim, false)).toEqual({
				mode: "available",
			});
		}
	});

	/*
	  No block, and the claim says the radio positively cannot. That is the
	  FM350's answer and the reason its 5G selector correctly does not render.
	*/
	const ABSENT_CLAIMS: readonly (SupportClaimState | undefined)[] = [
		undefined,
		"unavailable",
		"capable",
		"certified",
	];

	it.each(ABSENT_CLAIMS)(
		"no advertised posture under the %s claim renders NOTHING",
		(claim) => {
			expect(fiveGCapabilityView(hidden, claim, false)).toEqual({
				mode: "absent",
			});
		},
	);

	/*
	  …and the two claims that mean "nobody has established this" keep their
	  reason on screen. Hiding them would send an operator hunting for a control
	  that is one Settings toggle away.
	*/
	it.each([
		["implemented", "network.modem.sections.capability.moduleDisabled"],
		["enabled", "network.modem.sections.capability.unproven"],
	] as const)("the %s claim is UNKNOWN with its own reason", (claim, key) => {
		const view = fiveGCapabilityView(hidden, claim, false);

		expect(view).toEqual({ mode: "unknown", reasonKey: key });
		expectWellFormed(view);
	});

	it("an unestablished claim stays unknown even with no SIM", () => {
		// noSim can only ever BLOCK a capability that exists; below `capable`
		// there is none to withhold, so it must not promote one.
		expect(fiveGCapabilityView(hidden, "enabled", true).mode).toBe("unknown");
	});
});
