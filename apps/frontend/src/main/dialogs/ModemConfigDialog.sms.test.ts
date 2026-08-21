// @vitest-environment jsdom
/**
 * ModemConfigDialog — the read-only SMS inbox (todo 39).
 *
 * Two things are being pinned here, and only one of them is a state table.
 *
 * The state table is the ordinary half: populated, empty, each transient
 * refusal, the capability withdrawal, and the manual re-read. Its load-bearing
 * assertion is that an EMPTY inbox and a REFUSED read never render the same
 * thing — `[]` means this modem has an inbox and it is empty, and a refusal
 * means we do not know what it holds. Collapsing those is the exact lie the
 * backend's typed refusals exist to prevent, and a UI that renders "No messages"
 * for `read_failed` would undo all of it on the last hop.
 *
 * The other half is a STRUCTURAL guarantee, not a behaviour: this section
 * contains no way to send, compose, reply to, or delete anything. That is
 * asserted against the rendered DOM — every button enumerated, every form
 * control counted — because the backend's read-only grep gate protects the
 * device and this protects the promise the operator is shown. A greyed-out
 * compose box would pass a grep and fail an operator.
 */

import type { Modem, SmsMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openModemAdvanced } from "../../tests/helpers/modem-advanced";
import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const getSms = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getSms,
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

/**
 * Shaped after the bench board's real Quectel inbox: an alphanumeric carrier
 * sender, a numeric shortcode, an hours-only UTC offset (mmcli's own
 * non-standard rendering), and a data-only message with no text at all. The
 * fixture copy is deliberately banal — the live SIM's inbox contains a one-time
 * code, and a fixture that imitated one would put a credential-shaped string in
 * every developer's test output for no benefit.
 */
const INBOX: SmsMessage[] = [
	{
		id: "36",
		from: "CLARO",
		timestamp: "2026-08-16T09:12:44-05",
		text: "Your plan renews tomorrow.",
		state: "received",
	},
	{
		id: "12",
		from: "44556",
		timestamp: "2026-08-15T21:03:10-05",
		text: "Balance update.",
		state: "received",
	},
	{
		id: "4",
		timestamp: "2026-08-14T07:55:02-05",
		text: "",
		state: "stored",
	},
];

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		...overrides,
	} as Modem;
}

function mount(overrides: Partial<Modem> = {}) {
	return render(ModemConfigDialog, {
		props: { open: true, modem: modem(overrides), deviceId: "0" },
	});
}

/**
 * Open the disclosure and wait for the read it triggers to be dispatched.
 *
 * It deliberately does NOT then assert the card is still there: the `unsupported`
 * answer withdraws the whole section, and a helper that required the card to
 * survive would make that outcome unreachable from a test.
 */
async function openInbox(): Promise<void> {
	// The card sits inside the "Advanced" disclosure, whose collapsed body is
	// `visibility: hidden` — so it is inaccessible until expanded, and any
	// assertion that runs the accessible-name algorithm has to address the
	// surface an operator can actually reach.
	await openModemAdvanced();
	await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
	await waitFor(() => expect(getSms).toHaveBeenCalled());
}

function resolveWith(messages: SmsMessage[]): void {
	getSms.mockResolvedValue({ success: true, messages });
}

function refuseWith(error: string): void {
	getSms.mockResolvedValue({ success: false, error });
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
	resetModemsFeed();
});

describe("progressive disclosure — folded, and the fold does real work", () => {
	it("renders the section closed and reads NOTHING until it is opened", async () => {
		resolveWith(INBOX);
		mount();

		const card = await screen.findByTestId("modem-sms-card");
		expect(card).toBeTruthy();
		expect(
			screen.getByTestId("modem-sms-toggle").getAttribute("aria-expanded"),
		).toBe("false");
		expect(getSms).not.toHaveBeenCalled();

		// Not merely hidden — a closed inbox holds no message text in the DOM at
		// all, so a page-source read reveals nothing the operator did not ask for.
		expect(screen.queryByTestId("modem-sms-list")).toBeNull();
		expect(card.textContent).not.toContain("Your plan renews tomorrow.");
	});

	it("reads once on the first open and not again on a re-open", async () => {
		resolveWith(INBOX);
		mount();

		await openInbox();
		expect(getSms).toHaveBeenCalledTimes(1);
		expect(getSms).toHaveBeenCalledWith({ device: "0" });

		await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
		expect(
			screen.getByTestId("modem-sms-toggle").getAttribute("aria-expanded"),
		).toBe("false");
		await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
		await screen.findByTestId("modem-sms-list");

		expect(getSms).toHaveBeenCalledTimes(1);
	});
});

describe("state table — populated", () => {
	it("lists the messages in wire order, newest first", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		const rows = await screen.findAllByTestId("modem-sms-message");
		expect(rows.map((row) => row.dataset.smsId)).toEqual(["36", "12", "4"]);
	});

	it("renders sender, time and text for each message", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		const [newest] = await screen.findAllByTestId("modem-sms-message");
		expect(newest?.textContent).toContain("CLARO");
		expect(newest?.textContent).toContain("Your plan renews tomorrow.");
	});

	it("sets timestamps in the mono data face, at the offset the network stamped", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		const [time] = await screen.findAllByTestId("modem-sms-time");
		// 09:12 is the CARRIER's wall clock (`…T09:12:44-05`). A browser-local
		// re-zoning would move it, and would move it differently per test machine.
		expect(time?.textContent?.trim()).toBe("2026-08-16 09:12");
		expect(time?.className).toContain("font-mono");
		expect(time?.getAttribute("dir")).toBe("ltr");
	});

	it("names an absent sender rather than leaving the row headless", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		const senders = await screen.findAllByTestId("modem-sms-from");
		expect(senders.at(-1)?.textContent).toMatch(/Unknown sender/i);
	});

	it("says a data-only message has no text instead of rendering a blank row", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		expect(
			(await screen.findByTestId("modem-sms-no-text")).textContent,
		).toMatch(/carries data only/i);
	});

	it("says an undated message has no time rather than inventing one", async () => {
		resolveWith([
			{ id: "9", from: "CLARO", text: "Undated.", state: "stored" },
		]);
		mount();
		await openInbox();

		expect(
			(await screen.findByTestId("modem-sms-no-time")).textContent,
		).toMatch(/No time reported/i);
		expect(screen.queryByTestId("modem-sms-time")).toBeNull();
	});

	it("counts the inbox in the header once it is known", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		expect(
			(await screen.findByTestId("modem-sms-count")).textContent,
		).toContain("3");
	});

	it("speaks the count ONCE — the digit is hidden from the accessible name", async () => {
		// Board-found (2026-08-17, the bench Quectel with 37 stored): the count
		// sits INSIDE the toggle, so name-from-content concatenated the visible
		// digit and the spoken phrase, and the button announced "37 37 messages
		// stored".
		resolveWith(INBOX);
		mount();
		await openInbox();

		const count = await screen.findByTestId("modem-sms-count");
		expect(
			count.querySelector("[aria-hidden='true']")?.textContent?.trim(),
		).toBe("3");
		expect(count.querySelector(".sr-only")?.textContent).toMatch(
			/3 messages stored/i,
		);

		// Queried BY ROLE AND NAME, which runs the real accessible-name algorithm
		// (aria-hidden subtrees excluded). A `textContent` assertion concatenates
		// them regardless and would have passed against the defect — which is
		// exactly how it reached the board.
		expect(
			screen.getByRole("button", { name: /3 messages stored/i }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /3 3 messages stored/i }),
		).toBeNull();
	});

	it("says the list is a WINDOW when it comes back at the cap", async () => {
		resolveWith(
			Array.from({ length: 50 }, (_, i) => ({
				id: String(100 - i),
				from: "CLARO",
				timestamp: "2026-08-16T09:12:44-05",
				text: `Message ${i}`,
				state: "received" as const,
			})),
		);
		mount();
		await openInbox();

		expect((await screen.findByTestId("modem-sms-capped")).textContent).toMatch(
			/50 most recent/i,
		);
	});

	it("draws no cap notice for an inbox under the cap", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		await screen.findByTestId("modem-sms-list");
		expect(screen.queryByTestId("modem-sms-capped")).toBeNull();
	});
});

describe("state table — empty", () => {
	it("renders a calm empty state, not an error", async () => {
		resolveWith([]);
		mount();
		await openInbox();

		const empty = await screen.findByTestId("modem-sms-empty");
		expect(empty.getAttribute("role")).toBe("status");
		expect(empty.textContent).toMatch(/No messages stored/i);
		expect(empty.className).not.toContain("text-status-error");
		expect(screen.queryByTestId("modem-sms-list")).toBeNull();
	});

	it("reports a real zero in the header count", async () => {
		resolveWith([]);
		mount();
		await openInbox();

		expect(
			(await screen.findByTestId("modem-sms-count")).textContent,
		).toContain("0");
	});
});

describe("state table — `unsupported` withdraws the whole section", () => {
	it("removes the section entirely and leaves the dialog intact", async () => {
		refuseWith("unsupported");
		mount();

		await openInbox();
		await waitFor(() =>
			expect(screen.queryByTestId("modem-sms-card")).toBeNull(),
		);

		// Nothing of the section survives — no header, no empty state, no band.
		expect(screen.queryByTestId("modem-sms-toggle")).toBeNull();
		expect(screen.queryByTestId("modem-sms-empty")).toBeNull();
		expect(screen.queryByTestId("modem-sms-refused")).toBeNull();
		expect(screen.queryByTestId("modem-sms-refresh")).toBeNull();

		// And the dialog the operator actually opened is untouched.
		expect(screen.getByRole("switch", { name: /Allow Roaming/i })).toBeTruthy();
		expect(screen.getByRole("switch", { name: /Automatic APN/i })).toBeTruthy();
		expect(screen.getAllByText("Quectel RM520N-GL").length).toBeGreaterThan(0);
	});

	it("never renders an empty inbox in place of the missing capability", async () => {
		refuseWith("unsupported");
		mount();
		await openInbox();

		await waitFor(() =>
			expect(screen.queryByTestId("modem-sms-card")).toBeNull(),
		);
		expect(document.body.textContent).not.toMatch(/No messages stored/i);
	});
});

describe("state table — transient refusals stay, calmly, and stay retryable", () => {
	it.each([
		["not_enabled", /still starting up/i],
		["unknown_modem", /no longer connected/i],
		["read_failed", /could not read/i],
	])(
		"%s renders its own sentence with the re-read still offered",
		async (error, copy) => {
			refuseWith(error);
			mount();
			await openInbox();

			const band = await screen.findByTestId("modem-sms-refused");
			expect(band.dataset.smsRefusal).toBe(error);
			// A status, not an alert: nothing the operator did failed, and all three
			// are states the device can leave on its own.
			expect(band.getAttribute("role")).toBe("status");
			expect(band.className).not.toContain("text-status-error");
			expect(band.textContent).toMatch(copy);

			expect(screen.getByTestId("modem-sms-refresh")).toBeTruthy();
			// The critical non-collapse: a refusal is NEVER an empty inbox.
			expect(screen.queryByTestId("modem-sms-empty")).toBeNull();
			expect(screen.queryByTestId("modem-sms-list")).toBeNull();
			expect(screen.queryByTestId("modem-sms-count")).toBeNull();
		},
	);

	it("a thrown transport error lands in the same honest band", async () => {
		getSms.mockRejectedValue(new Error("socket closed"));
		mount();
		await openInbox();

		const band = await screen.findByTestId("modem-sms-refused");
		expect(band.dataset.smsRefusal).toBe("read_failed");
		expect(screen.queryByTestId("modem-sms-empty")).toBeNull();
	});
});

describe("state table — manual refresh", () => {
	it("re-reads on demand and replaces the list with the new answer", async () => {
		resolveWith([INBOX[0] as SmsMessage]);
		mount();
		await openInbox();
		expect(await screen.findAllByTestId("modem-sms-message")).toHaveLength(1);

		resolveWith(INBOX);
		await fireEvent.click(screen.getByTestId("modem-sms-refresh"));

		await waitFor(() => expect(getSms).toHaveBeenCalledTimes(2));
		await waitFor(async () =>
			expect(await screen.findAllByTestId("modem-sms-message")).toHaveLength(3),
		);
	});

	it("recovers from a refusal without reopening the section", async () => {
		refuseWith("not_enabled");
		mount();
		await openInbox();
		await screen.findByTestId("modem-sms-refused");

		resolveWith(INBOX);
		await fireEvent.click(screen.getByTestId("modem-sms-refresh"));

		await screen.findByTestId("modem-sms-list");
		expect(screen.queryByTestId("modem-sms-refused")).toBeNull();
	});

	it("withdraws the section when a re-read reveals the capability is absent", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();
		await screen.findByTestId("modem-sms-list");

		refuseWith("unsupported");
		await fireEvent.click(screen.getByTestId("modem-sms-refresh"));

		await waitFor(() =>
			expect(screen.queryByTestId("modem-sms-card")).toBeNull(),
		);
	});

	it("does not stack concurrent reads", async () => {
		let release: ((value: unknown) => void) | undefined;
		getSms.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		mount();
		await fireEvent.click(screen.getByTestId("modem-sms-toggle"));
		await waitFor(() => expect(getSms).toHaveBeenCalledTimes(1));

		await fireEvent.click(screen.getByTestId("modem-sms-refresh"));
		expect(getSms).toHaveBeenCalledTimes(1);

		release?.({ success: true, messages: INBOX });
		await screen.findByTestId("modem-sms-list");
	});
});

/**
 * The structural guarantee. `modems.getSms` is list + read and the backend
 * grep-gates every send/delete verb out of the codebase; this is the same
 * promise asserted where the operator can actually see it.
 */
describe("READ-ONLY: no mutation affordance exists in the rendered DOM", () => {
	const MUTATION_COPY =
		/send|compose|reply|forward|delete|remove|discard|new message/i;

	it("the open section contains exactly two controls: the fold and the re-read", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();
		const card = await screen.findByTestId("modem-sms-card");
		await screen.findByTestId("modem-sms-list");

		const buttons = Array.from(card.querySelectorAll("button"));
		expect(buttons.map((button) => button.dataset.testid).sort()).toEqual([
			"modem-sms-refresh",
			"modem-sms-toggle",
		]);
	});

	it("carries NO text entry of any kind — a compose box cannot be typed into if it does not exist", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();
		const card = await screen.findByTestId("modem-sms-card");
		await screen.findByTestId("modem-sms-list");

		expect(
			card.querySelectorAll(
				'input, textarea, select, [contenteditable="true"], form, [role="textbox"], [role="combobox"], [role="switch"], [role="menuitem"]',
			),
		).toHaveLength(0);
	});

	it("names nothing that a send, compose or delete would be named", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();
		const card = await screen.findByTestId("modem-sms-card");
		await screen.findByTestId("modem-sms-list");

		for (const control of card.querySelectorAll("button, a, [role='button']")) {
			const name = [
				control.textContent ?? "",
				control.getAttribute("aria-label") ?? "",
				control.getAttribute("title") ?? "",
			].join(" ");
			expect(name).not.toMatch(MUTATION_COPY);
		}
	});

	it("puts no per-message action beside any message", async () => {
		resolveWith(INBOX);
		mount();
		await openInbox();

		for (const row of await screen.findAllByTestId("modem-sms-message")) {
			expect(
				row.querySelectorAll(
					'button, a, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"]',
				),
			).toHaveLength(0);
			expect(
				Array.from(row.querySelectorAll("[tabindex]")).filter(
					(el) => Number(el.getAttribute("tabindex")) >= 0,
				),
			).toHaveLength(0);
		}
	});
});
