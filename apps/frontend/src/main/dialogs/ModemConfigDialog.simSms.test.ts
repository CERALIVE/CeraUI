// @vitest-environment jsdom
/**
 * ModemConfigDialog — SIM identity and the SMS surface, as REAL flows.
 *
 * Two claims are pinned here, and neither is "the node exists".
 *
 * ── 1. SIM PRESENCE IS FOUR-VALUED, AND `unknown` IS NOT ABSENCE ────────────
 *
 * The dialog used to state SIM presence exactly once, through a warning banner
 * that fires for ONE of the four states. So `present` and `unknown` rendered
 * identically — as nothing — and an operator could not tell a healthy slot from
 * a slot nothing could read. The SIM identity group now leads with the SHARED
 * `SimBlock`, the same component `RouterDongleDialog` draws, resolved by
 * `deriveSim`.
 *
 * The rule `deriveSim` implements is the stack's own evidence model: `absent` is
 * reachable ONLY from a device that positively said so — ModemManager's
 * `sim-missing` failure reason, which the wire carries as `no_sim`, or a
 * dongle's own `router_admin.sim` — and anything that is not positively
 * `present` resolves `unknown`. A blank SIM object path is the ABSENCE OF AN
 * ANSWER, and the whole point of the fourth state is that it must not be
 * rendered as an answer.
 *
 * ── 2. AN EMPTY INBOX IS A SUCCESSFUL RESULT, NOT A REFUSAL ────────────────
 *
 * `{success: true, messages: []}` means this modem has an inbox and it is
 * empty; every refusal means we do not know what it holds. This asserts the two
 * are distinct in BOTH directions — the empty state never renders for a
 * refusal, the refusal band never renders for an empty read — and that a
 * refused read recovers into an honest empty state on the next attempt.
 *
 * ── AND BOTH ARE REACHED, NOT MERELY PRESENT ───────────────────────────────
 *
 * Everything above lives inside the "Advanced" disclosure, which is collapsed
 * on every open and whose body is `visibility: hidden` while it is. A node that
 * is in the DOM but withdrawn from hit testing is not a surface an operator
 * has; the reachability block drives the real disclosure and then the real
 * control, and the SMS half proves the click dispatches an actual read.
 *
 * The two subscriber identifiers ride that same disclosure, which is what
 * "hidden until revealed" means for the ICCID (printed on the card, deliberately
 * NOT masked — `ModemConfigDialog.iccid.test.ts` owns that contract). The own
 * number carries a SECOND, explicit reveal on top of it, and its value is not in
 * the DOM at all before that. Neither may reach a log, in any state.
 */

import type { Modem, SmsMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openModemAdvanced } from "../../tests/helpers/modem-advanced";
import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const getSms = vi.hoisted(() => vi.fn());
const usbModeOptions = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getSms,
			getUsbModeOptions: usbModeOptions,
			setUsbMode: vi.fn(),
			configure: vi.fn(),
			scan: vi.fn(),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("$lib/helpers/clipboard", () => ({ copyToClipboard }));

/** The bench Quectel's real ICCID — printed on the card, so not redacted. */
const BOARD_ICCID = "8957123102400060892";

/** A subscriber number, invented: a real MSISDN identifies a real person. */
const OWN_NUMBER = "+573001234567";

/**
 * The SMS toggle's own accessible name, matched on its DESCRIPTION rather than
 * its title: the Advanced disclosure's summary also contains the word
 * "messages", so a `/messages/i` name query resolves that instead and a
 * reachability test written against it can never fail.
 */
const SMS_TOGGLE_NAME = /stored on this sim/i;

/**
 * Serving-cell readings, present only so the detail card has a reason to render
 * that has nothing to do with the SIM. That separation is what makes the
 * `unknown` case assertable at all: the card must open for a reason other than
 * the state under test, or the test would prove the gate rather than the render.
 */
const CELL_INFO = {
	tech: "lte",
	band: "B4",
	rsrp: -92,
} as unknown as Modem["cell_info"];

function modemWith(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan3",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 74,
			roaming: false,
		},
		...overrides,
	} as Modem;
}

function mount(overrides: Partial<Modem> = {}, deviceId = "3") {
	return render(ModemConfigDialog, {
		props: { open: true, modem: modemWith(overrides), deviceId },
	});
}

function resolveWith(messages: SmsMessage[]): void {
	getSms.mockResolvedValue({ success: true, messages });
}

function refuseWith(error: string): void {
	getSms.mockResolvedValue({ success: false, error });
}

/** Expand the disclosure, open the inbox, and wait for the read it triggers. */
async function openInbox(): Promise<void> {
	await openModemAdvanced();
	await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
	await waitFor(() => expect(getSms).toHaveBeenCalled());
}

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	getSms.mockReset();
	getSms.mockResolvedValue({ success: true, messages: [] });
	usbModeOptions.mockReset();
	usbModeOptions.mockResolvedValue({ certified: [] });
	copyToClipboard.mockReset();
	copyToClipboard.mockResolvedValue(true);
	resetModemsFeed();
});

describe("SIM presence renders the stack's evidence model", () => {
	it("states a POSITIVELY-present slot instead of leaving it silent", async () => {
		mount({ no_sim: false });
		await openModemAdvanced();

		const block = await screen.findByTestId("modem-sim");
		expect(block.dataset.simPresence).toBe("present");
		expect(screen.getByTestId("modem-sim-present")).toBeTruthy();
	});

	it("states a lock as a lock, carrying which lock it is", async () => {
		mount({ sim_lock: { required: "sim-pin" } } as Partial<Modem>);
		await openModemAdvanced();

		const block = await screen.findByTestId("modem-sim");
		expect(block.dataset.simPresence).toBe("locked");
		expect(screen.getByTestId("modem-sim-locked").dataset.simLock).toBe(
			"sim-pin",
		);
	});

	it("claims ABSENCE only where the device positively claimed it", async () => {
		mount({ no_sim: true, cell_info: CELL_INFO });
		await openModemAdvanced();

		const block = await screen.findByTestId("modem-sim");
		expect(block.dataset.simPresence).toBe("absent");
		expect(screen.getByTestId("modem-sim-absent")).toBeTruthy();
	});

	it("reads a dongle's OWN slot verdict, which `no_sim` cannot carry", async () => {
		// A `router-ethernet` dongle is invisible to ModemManager, so it never
		// publishes `no_sim` at all — its slot rides `router_admin.sim`. Reading
		// only the first field is how this surface used to miss the class
		// entirely.
		mount({
			router_admin: { admin_url: "http://192.168.8.1", sim: "present" },
		} as Partial<Modem>);
		await openModemAdvanced();

		expect((await screen.findByTestId("modem-sim")).dataset.simPresence).toBe(
			"present",
		);
	});
});

describe("`unknown` is the absence of an answer, and never renders as absence", () => {
	/**
	 * The forcing case: a modem that published NEITHER slot field. Its detail
	 * card is open for an unrelated reason (serving-cell readings), so the SIM
	 * block is on screen and has to say something — and the only honest thing it
	 * can say is that the device did not say.
	 */
	it("renders its own distinct line, not the No-SIM pill", async () => {
		mount({ cell_info: CELL_INFO });
		await openModemAdvanced();

		const block = await screen.findByTestId("modem-sim");
		expect(block.dataset.simPresence).toBe("unknown");
		expect(screen.getByTestId("modem-sim-unknown")).toBeTruthy();
		expect(screen.queryByTestId("modem-sim-absent")).toBeNull();
	});

	it("puts NO 'No SIM' tag anywhere in the dialog", async () => {
		mount({ cell_info: CELL_INFO });
		await openModemAdvanced();
		await screen.findByTestId("modem-sim-unknown");

		// `data-no-sim` is `NoSimBadge`'s own marker, so this covers the banner,
		// the block, and any future third site at once. It is queried off
		// `document` rather than the render result's `container` because the
		// dialog PORTALS its content out of that subtree — a `container`-scoped
		// sweep for an absence here would pass no matter what rendered.
		expect(document.querySelectorAll("[data-no-sim]")).toHaveLength(0);
		expect(screen.queryByTestId("modem-no-sim-banner")).toBeNull();
	});

	it("leaves the configuration form LIVE — an unread slot is not a refusal", async () => {
		mount({ cell_info: CELL_INFO });
		await screen.findByTestId("modem-advanced-toggle");

		// The whole configuration fieldset is `disabled={noSim}`, so this is the
		// operator-visible consequence of the state: an unread slot must not cost
		// them the APN field they opened the dialog to change.
		const fieldsets = Array.from(document.querySelectorAll("fieldset"));
		expect(fieldsets.length).toBeGreaterThan(0);
		expect(fieldsets.some((set) => set.disabled)).toBe(false);
	});

	it("still draws the pill and the banner for a device that DID say", async () => {
		// The negative control for the two assertions above: both markers they
		// require to be absent are genuinely reachable on the same surface.
		mount({ no_sim: true, cell_info: CELL_INFO });
		await openModemAdvanced();
		await screen.findByTestId("modem-sim-absent");

		expect(document.querySelectorAll("[data-no-sim]").length).toBeGreaterThan(
			0,
		);
		expect(screen.getByTestId("modem-no-sim-banner")).toBeTruthy();
		expect(
			Array.from(document.querySelectorAll("fieldset")).some(
				(set) => set.disabled,
			),
		).toBe(true);
	});
});

describe("a stated SIM opens the card; an unstated one adds nothing", () => {
	it("opens the detail card for a modem whose ONLY reading is its slot", async () => {
		mount({ no_sim: false });
		await openModemAdvanced();

		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.getByTestId("modem-sim-present")).toBeTruthy();
		// Nothing else was reported, so nothing else is claimed.
		expect(screen.queryByTestId("modem-cell-info")).toBeNull();
		expect(screen.queryByTestId("modem-iccid")).toBeNull();
	});

	it("renders NO card for a modem that stated neither a slot nor anything else", async () => {
		mount();
		await openModemAdvanced();

		expect(screen.queryByTestId("modem-detail-card")).toBeNull();
		expect(screen.queryByTestId("modem-sim")).toBeNull();
	});

	it("renders no second, otherwise-empty card for an absent slot", async () => {
		// `absent` already owns the primary banner. A card in the secondary
		// column restating it is the density regression, not a second opinion.
		mount({ no_sim: true });
		await openModemAdvanced();

		expect(screen.getByTestId("modem-no-sim-banner")).toBeTruthy();
		expect(screen.queryByTestId("modem-detail-card")).toBeNull();
	});
});

describe("the SIM identity group is REACHED, not merely present", () => {
	it("is withdrawn from the accessible surface until the disclosure is opened", async () => {
		mount({ no_sim: false, iccid: BOARD_ICCID });

		// Mounted (the disclosure keeps its body in the DOM) but inaccessible:
		// the collapsed body is `visibility: hidden`, which Testing Library's
		// accessibility check honours.
		expect(screen.getByTestId("modem-sim")).toBeTruthy();
		expect(
			screen.getByTestId("modem-advanced-toggle").getAttribute("aria-expanded"),
		).toBe("false");
		expect(
			screen.queryByRole("button", { name: /copy the sim id/i }),
		).toBeNull();

		await openModemAdvanced();

		expect(
			screen.getByRole("button", { name: /copy the sim id/i }),
		).toBeTruthy();
	});

	it("copies the ICCID through the real control once it is reachable", async () => {
		mount({ iccid: BOARD_ICCID });
		await openModemAdvanced();

		await fireEvent.click(screen.getByTestId("modem-iccid-copy"));
		expect(copyToClipboard).toHaveBeenCalledWith(BOARD_ICCID);
	});
});

describe("an EMPTY inbox and a REFUSED read are different answers", () => {
	it("renders a successful empty read as an empty inbox, with a real zero", async () => {
		resolveWith([]);
		mount();
		await openInbox();

		expect(await screen.findByTestId("modem-sms-empty")).toBeTruthy();
		expect(screen.queryByTestId("modem-sms-refused")).toBeNull();
		expect(screen.queryByTestId("modem-sms-list")).toBeNull();
		expect(screen.getByTestId("modem-sms-count").textContent).toContain("0");
	});

	it("renders a refusal as a refusal, naming which one, and counts nothing", async () => {
		refuseWith("read_failed");
		mount();
		await openInbox();

		const band = await screen.findByTestId("modem-sms-refused");
		expect(band.dataset.smsRefusal).toBe("read_failed");
		expect(screen.queryByTestId("modem-sms-empty")).toBeNull();
		// A count would assert we know the inbox holds nothing. We do not.
		expect(screen.queryByTestId("modem-sms-count")).toBeNull();
	});

	it("says two different things, and never both at once", async () => {
		resolveWith([]);
		const empty = mount();
		await openInbox();
		const emptyText = (
			await screen.findByTestId("modem-sms-empty")
		).textContent?.trim();
		empty.unmount();

		getSms.mockReset();
		refuseWith("read_failed");
		mount();
		await openInbox();
		const refusedText = (
			await screen.findByTestId("modem-sms-refused")
		).textContent?.trim();

		expect(emptyText).toBeTruthy();
		expect(refusedText).toBeTruthy();
		expect(refusedText).not.toBe(emptyText);
	});

	it("recovers from a refusal into an honest empty state on a re-read", async () => {
		refuseWith("not_enabled");
		mount();
		await openInbox();
		await screen.findByTestId("modem-sms-refused");

		resolveWith([]);
		await fireEvent.click(screen.getByTestId("modem-sms-refresh"));

		await waitFor(() =>
			expect(screen.queryByTestId("modem-sms-refused")).toBeNull(),
		);
		expect(screen.getByTestId("modem-sms-empty")).toBeTruthy();
	});
});

describe("the SMS surface is REACHED, and the reach does real work", () => {
	it("is unreachable while Advanced is collapsed, and dispatches a read once opened", async () => {
		resolveWith([]);
		mount();

		expect(screen.getByTestId("modem-sms-card")).toBeTruthy();
		expect(screen.queryByRole("button", { name: SMS_TOGGLE_NAME })).toBeNull();
		expect(getSms).not.toHaveBeenCalled();

		await openModemAdvanced();
		const toggle = screen.getByRole("button", { name: SMS_TOGGLE_NAME });
		await fireEvent.click(toggle);

		await waitFor(() => expect(getSms).toHaveBeenCalledWith({ device: "3" }));
	});
});

describe("neither subscriber identifier is displayed early, and neither is logged", () => {
	it("keeps both inside the disclosure that is collapsed on every open", async () => {
		mount({ iccid: BOARD_ICCID, own_numbers: [OWN_NUMBER] });

		const body = screen.getByTestId("modem-advanced-body");
		expect(body.contains(screen.getByTestId("modem-iccid"))).toBe(true);
		expect(body.contains(screen.getByTestId("modem-own-number"))).toBe(true);
		expect(
			screen.getByTestId("modem-advanced-toggle").getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("keeps the own number OUT OF THE DOM until its own reveal", async () => {
		mount({ iccid: BOARD_ICCID, own_numbers: [OWN_NUMBER] });
		await openModemAdvanced();

		expect(document.body.textContent).not.toContain(OWN_NUMBER);

		await fireEvent.click(screen.getByTestId("modem-own-number-toggle"));
		expect(
			screen.getByTestId("modem-own-number-value-0").textContent,
		).toContain(OWN_NUMBER);
	});

	it("emits neither value to any console lane, revealed or not", async () => {
		const lanes = ["log", "info", "warn", "error", "debug"] as const;
		const seen: unknown[][] = [];
		const spies = lanes.map((lane) =>
			vi.spyOn(console, lane).mockImplementation((...args: unknown[]) => {
				seen.push(args);
			}),
		);

		try {
			mount({ iccid: BOARD_ICCID, own_numbers: [OWN_NUMBER] });
			await openModemAdvanced();
			await fireEvent.click(screen.getByTestId("modem-own-number-toggle"));
			await fireEvent.click(screen.getByTestId("modem-iccid-copy"));
			await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
			await waitFor(() => expect(getSms).toHaveBeenCalled());

			const emitted = seen.map((args) => JSON.stringify(args)).join("\n");
			expect(emitted).not.toContain(BOARD_ICCID);
			expect(emitted).not.toContain(OWN_NUMBER);

			// Non-vacuity: the detector reads the lanes it claims to read.
			console.warn("planted", BOARD_ICCID, OWN_NUMBER);
			const replanted = seen.map((args) => JSON.stringify(args)).join("\n");
			expect(replanted).toContain(BOARD_ICCID);
			expect(replanted).toContain(OWN_NUMBER);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
