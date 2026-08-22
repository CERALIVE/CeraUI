// @vitest-environment jsdom
/**
 * ModemUssdSection — the dialogue, against the real DOM.
 *
 * The pure rule is covered in `lib/modem/ussd-session.test.ts`; what can only be
 * proven here is what an operator actually ends up looking at. Four of the five
 * blocks below are about a surface REFUSING to say something:
 *
 *  - a modem with no claim contributes ZERO nodes, so a device that cannot do
 *    USSD does not get a ghost row inviting an operator to try;
 *  - an unanswered dialogue lands on an explicit UNKNOWN band and the spinner is
 *    gone, because "we do not know whether it acted" is the honest third answer
 *    and an endless spinner is the failure this replaces;
 *  - a carrier that will not carry USSD on a data-only registration says exactly
 *    that, in its own words, rather than through the generic failure sentence
 *    that would send an operator hunting for a firmware fix;
 *  - a second dialogue is refused in the UI with no RPC dispatched at all, which
 *    is asserted by CALL COUNT rather than by the absence of a rendered error —
 *    a surface that dispatched and rendered the device's refusal would look
 *    identical and would still be spending the operator's single network slot.
 *
 * The fifth is the containment gate. Both directions of a USSD dialogue carry
 * subscriber content, so the fixtures below are deliberately shaped like the
 * things that leak — a voucher-shaped code and a balance — and the test greps
 * the whole document, every console channel and every toast for them.
 */

import type { ModemUssdOutput, UssdSessionSnapshot } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModemUssdSection from "./ModemUssdSection.svelte";

const getUssd = vi.hoisted(() => vi.fn());
const ussdInitiate = vi.hoisted(() => vi.fn());
const ussdRespond = vi.hoisted(() => vi.fn());
const ussdCancel = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { getUssd, ussdInitiate, ussdRespond, ussdCancel } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: toastSuccess },
}));

/**
 * Shaped like the content that actually leaks. The command carries a
 * voucher-looking tail and the replies carry a balance, because a fixture of
 * `"test"` and `"reply"` would pass a containment gate that a real dialogue
 * fails — those strings occur in ordinary markup, so a grep for them proves
 * nothing.
 */
const COMMAND = "*611*4242118899#";
const MENU = "1. Balance\n2. Top up\n3. My number";
const BALANCE = "Your balance is COP 17,400 and expires 2026-09-30.";

const idle: UssdSessionSnapshot = { state: "idle" };

function ok(session: UssdSessionSnapshot, ussdReply?: string): ModemUssdOutput {
	return {
		success: true,
		session,
		...(ussdReply === undefined ? {} : { ussdReply }),
	};
}

/**
 * The claim is REQUIRED, deliberately. A default parameter fires on an explicit
 * `undefined`, so a `mount(undefined)` written for the no-claim case would
 * silently render the `capable` surface and the strongest gate in this file
 * would assert nothing.
 */
function mount(claim: string | undefined) {
	return render(ModemUssdSection, {
		props: { deviceId: "3", claim: claim as never },
	});
}

/** Everything a reader or an assistive technology can reach, plus every attribute. */
function documentText(): string {
	const inputs = Array.from(
		document.querySelectorAll<HTMLInputElement>("input"),
	)
		.map((input) => input.value)
		.join("\u0000");
	return `${document.body.innerHTML}\u0000${document.body.textContent ?? ""}\u0000${inputs}`;
}

async function openDialogue(): Promise<void> {
	await waitFor(() => expect(getUssd).toHaveBeenCalled());
	await screen.findByTestId("modem-ussd-command");
	await fireEvent.input(screen.getByTestId("modem-ussd-command"), {
		target: { value: COMMAND },
	});
	await fireEvent.click(screen.getByTestId("modem-ussd-send"));
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	getUssd.mockResolvedValue(ok(idle));
	for (const channel of ["log", "info", "warn", "error", "debug"] as const) {
		consoleSpies.push(vi.spyOn(console, channel).mockImplementation(() => {}));
	}
});

afterEach(() => {
	for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe("a modem that cannot do USSD contributes NOTHING", () => {
	it.each([
		["no claim published at all", undefined],
		["a modem that positively lacks it", "unavailable"],
	])("renders zero USSD DOM for %s", async (_label, claim) => {
		const { container } = mount(claim);
		await waitFor(() => expect(getUssd).toHaveBeenCalled());

		expect(container.querySelector("[data-testid^='modem-ussd']")).toBeNull();
		expect(container.textContent?.trim()).toBe("");
	});

	it("distinguishes an unproven capability from an absent one", async () => {
		mount("enabled");
		// CT-3/CT-4: a diagnostic saying nothing is established, and NO control —
		// a disabled Send would claim a capability nobody has shown exists.
		expect(await screen.findByTestId("modem-ussd-unknown")).toBeTruthy();
		expect(screen.queryByTestId("modem-ussd-send")).toBeNull();
		expect(screen.queryByTestId("modem-ussd-command")).toBeNull();
	});
});

describe("the happy dialogue — initiate, answer, close", () => {
	it("carries a menu, accepts an answer, and closes on the operator's word", async () => {
		ussdInitiate.mockResolvedValue(ok({ state: "awaiting-reply" }, MENU));
		mount("capable");
		await openDialogue();

		expect(ussdInitiate).toHaveBeenCalledWith({
			device: "3",
			ussdCommand: COMMAND,
		});
		expect(
			(await screen.findByTestId("modem-ussd-reply")).textContent,
		).toContain("1. Balance");

		// The network is ASKING, so the answer field is the live control and the
		// command field is gone — there is no second code to send into an open slot.
		expect(screen.getByTestId("modem-ussd-response")).toBeTruthy();
		expect(screen.queryByTestId("modem-ussd-command")).toBeNull();

		ussdRespond.mockResolvedValue(ok({ state: "active" }, BALANCE));
		await fireEvent.input(screen.getByTestId("modem-ussd-response"), {
			target: { value: "1" },
		});
		await fireEvent.click(screen.getByTestId("modem-ussd-respond"));

		expect(ussdRespond).toHaveBeenCalledWith({
			device: "3",
			ussdResponse: "1",
		});
		await waitFor(() =>
			expect(screen.getByTestId("modem-ussd-reply").textContent).toContain(
				"balance is COP",
			),
		);

		// `active` holds the slot with nothing pending: only a close is legal.
		expect(await screen.findByTestId("modem-ussd-open-hint")).toBeTruthy();
		expect(screen.queryByTestId("modem-ussd-response")).toBeNull();

		ussdCancel.mockResolvedValue(ok({ state: "closed", outcome: "cancelled" }));
		await fireEvent.click(screen.getByTestId("modem-ussd-cancel"));

		await waitFor(() =>
			expect(
				screen.getByTestId("modem-ussd-outcome").getAttribute("data-outcome"),
			).toBe("applied"),
		);
		expect(
			screen
				.getByTestId("modem-ussd-session")
				.getAttribute("data-session-outcome"),
		).toBe("cancelled");
		// Closed means a fresh code is legal again.
		expect(screen.getByTestId("modem-ussd-command")).toBeTruthy();
	});
});

describe("an unanswered dialogue ends in an explicit UNKNOWN, never a spinner", () => {
	it("resolves a timeout to the unknown band and retires the spinner", async () => {
		ussdInitiate.mockResolvedValue(
			ok({ state: "closed", outcome: "timed-out" }),
		);
		mount("capable");
		await openDialogue();

		const band = await screen.findByTestId("modem-ussd-outcome");
		// NOT `applied` and NOT `refused`: the carrier may have acted on the last
		// message and may not, and rendering either would settle a question nobody
		// can answer.
		expect(band.getAttribute("data-outcome")).toBe("unknown");
		expect(band.textContent).toMatch(/unknown/i);

		expect(screen.queryByTestId("modem-ussd-working")).toBeNull();
		expect(
			screen
				.getByTestId("modem-ussd-session")
				.getAttribute("data-session-outcome"),
		).toBe("timed-out");
	});

	it("does NOT retry a timed-out dialogue on its own", async () => {
		ussdInitiate.mockResolvedValue(
			ok({ state: "closed", outcome: "timed-out" }),
		);
		mount("capable");
		await openDialogue();
		await screen.findByTestId("modem-ussd-outcome");

		// A retry would open a SECOND dialogue against a slot whose state nobody
		// knows — the operator decides, and only one call was ever made.
		expect(ussdInitiate).toHaveBeenCalledTimes(1);
	});
});

describe("a carrier policy is not a device fault", () => {
	it("gives lte-only-unsupported its own band, distinct from a generic failure", async () => {
		ussdInitiate.mockResolvedValue({
			success: false,
			error: "lte-only-unsupported",
			session: {
				state: "closed",
				outcome: "failed",
				refusal: "lte-only-unsupported",
			},
		} satisfies ModemUssdOutput);
		mount("capable");
		await openDialogue();

		const band = await screen.findByTestId("modem-ussd-policy");
		expect(band.getAttribute("data-ussd-policy")).toBe("lte-only-unsupported");
		// It states the modem is fine, which is the whole point of separating it.
		expect(band.textContent).toMatch(/carrier/i);
		expect(band.textContent).toMatch(/nothing to fix|nothing is wrong/i);

		// And it is NOT ALSO rendered through the generic device-refusal line.
		expect(screen.queryByTestId("modem-ussd-reason")).toBeNull();
	});

	it("routes an ordinary refusal through the generic line, not the policy band", async () => {
		ussdInitiate.mockResolvedValue({
			success: false,
			error: "carrier-rejected",
			session: {
				state: "closed",
				outcome: "failed",
				refusal: "carrier-rejected",
			},
		} satisfies ModemUssdOutput);
		mount("capable");
		await openDialogue();

		await screen.findByTestId("modem-ussd-reason");
		expect(screen.queryByTestId("modem-ussd-policy")).toBeNull();
	});

	it("the two never render the same sentence", async () => {
		ussdInitiate.mockResolvedValue({
			success: false,
			error: "lte-only-unsupported",
			session: {
				state: "closed",
				outcome: "failed",
				refusal: "lte-only-unsupported",
			},
		} satisfies ModemUssdOutput);
		const policy = mount("capable");
		await openDialogue();
		const policyText = (await screen.findByTestId("modem-ussd-outcome"))
			.textContent;
		policy.unmount();

		vi.clearAllMocks();
		getUssd.mockResolvedValue(ok(idle));
		ussdInitiate.mockResolvedValue({
			success: false,
			error: "carrier-rejected",
			session: {
				state: "closed",
				outcome: "failed",
				refusal: "carrier-rejected",
			},
		} satisfies ModemUssdOutput);
		mount("capable");
		await openDialogue();
		const genericText = (await screen.findByTestId("modem-ussd-outcome"))
			.textContent;

		expect(policyText).not.toBe(genericText);
	});
});

describe("a second dialogue is refused HERE, before the network is asked", () => {
	it.each([
		["awaiting-reply", "awaiting-reply"],
		["active", "active"],
		["initiating", "initiating"],
	])(
		"dispatches nothing while the slot is held (%s)",
		async (_label, state) => {
			getUssd.mockResolvedValue(ok({ state } as UssdSessionSnapshot));
			mount("capable");
			await waitFor(() => expect(getUssd).toHaveBeenCalled());
			await screen.findByTestId("modem-ussd-session");

			// The command form is not even offered while a dialogue holds the slot.
			expect(screen.queryByTestId("modem-ussd-command")).toBeNull();
			expect(screen.queryByTestId("modem-ussd-send")).toBeNull();
			expect(ussdInitiate).not.toHaveBeenCalled();
		},
	);

	it("says WHY, on screen, rather than only disabling", async () => {
		getUssd.mockResolvedValue(ok({ state: "active" }));
		mount("capable");
		const reason = await screen.findByTestId("modem-ussd-reason");
		expect(reason.textContent).toMatch(/already open/i);
		// ON SCREEN, not in a `title` — the kiosk touchscreen cannot hover to
		// reveal one, so a reason that lives only in an attribute is unreachable.
		expect(reason.getAttribute("title")).toBeNull();
		expect(reason.getAttribute("aria-hidden")).toBeNull();
	});

	it("keeps Send inert until the code is a shape the boundary accepts", async () => {
		mount("capable");
		await waitFor(() => expect(getUssd).toHaveBeenCalled());
		const send = (await screen.findByTestId(
			"modem-ussd-send",
		)) as HTMLButtonElement;
		expect(send.disabled).toBe(true);

		await fireEvent.input(screen.getByTestId("modem-ussd-command"), {
			target: { value: "*611" },
		});
		expect(send.disabled).toBe(true);

		await fireEvent.input(screen.getByTestId("modem-ussd-command"), {
			target: { value: "*611#" },
		});
		expect(send.disabled).toBe(false);

		await fireEvent.click(send);
		expect(ussdInitiate).toHaveBeenCalledTimes(1);
	});
});

describe("subscriber content is contained", () => {
	it("never logs or toasts the code or the reply, and holds the reply in ONE node", async () => {
		ussdInitiate.mockResolvedValue(ok({ state: "awaiting-reply" }, MENU));
		mount("capable");
		await openDialogue();
		await screen.findByTestId("modem-ussd-reply");

		// The code is out of the DOM the moment it is dispatched: it is never
		// echoed into a heading, a retry affordance or the field it was typed in.
		expect(documentText()).not.toContain(COMMAND);

		// The reply IS rendered — that is what the operator asked for — but in
		// exactly one marked node and nowhere else.
		const node = screen.getByTestId("modem-ussd-reply");
		expect(node.textContent).toContain("Balance");
		node.remove();
		expect(documentText()).not.toContain(MENU);
	});

	it("leaves NEITHER string anywhere once the operator starts over", async () => {
		ussdInitiate.mockResolvedValue(
			ok({ state: "closed", outcome: "completed" }, BALANCE),
		);
		mount("capable");
		await openDialogue();
		await screen.findByTestId("modem-ussd-reply");

		await fireEvent.click(await screen.findByTestId("modem-ussd-new"));

		await waitFor(() =>
			expect(screen.queryByTestId("modem-ussd-reply")).toBeNull(),
		);
		const rendered = documentText();
		expect(rendered).not.toContain(COMMAND);
		expect(rendered).not.toContain(BALANCE);
	});

	it("emits neither string on ANY console channel or toast", async () => {
		ussdInitiate.mockResolvedValue(ok({ state: "awaiting-reply" }, MENU));
		ussdRespond.mockResolvedValue(
			ok({ state: "closed", outcome: "completed" }, BALANCE),
		);
		mount("capable");
		await openDialogue();
		await screen.findByTestId("modem-ussd-response");
		await fireEvent.input(screen.getByTestId("modem-ussd-response"), {
			target: { value: "1" },
		});
		await fireEvent.click(screen.getByTestId("modem-ussd-respond"));
		await waitFor(() => expect(ussdRespond).toHaveBeenCalled());

		const emitted = [
			...consoleSpies.flatMap((spy) => spy.mock.calls),
			...toastError.mock.calls,
			...toastSuccess.mock.calls,
		]
			.flat()
			.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
			.join("\u0000");

		for (const secret of [COMMAND, MENU, BALANCE]) {
			expect(emitted).not.toContain(secret);
		}
	});

	it("proves the grep would actually catch a leak", async () => {
		// Non-vacuity: a containment gate nobody can show red is a gate nobody
		// should trust. The same predicate, handed the string, must fail.
		ussdInitiate.mockResolvedValue(ok({ state: "awaiting-reply" }, MENU));
		mount("capable");
		await openDialogue();
		await screen.findByTestId("modem-ussd-reply");
		expect(documentText()).toContain(MENU);
	});
});
