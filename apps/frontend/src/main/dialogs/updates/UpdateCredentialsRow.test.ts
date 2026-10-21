// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type { UpdateCredentials } from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAY_MS } from "$lib/updates/credential-expiry";
import { formatUpdateTime } from "$lib/updates/update-view";

import ConnectionSection from "./ConnectionSection.svelte";
import UpdateCredentialsRow from "./UpdateCredentialsRow.svelte";

const NOW = Date.UTC(2026, 9, 20, 12);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setLocale("en");
});

function row(credentials: UpdateCredentials | undefined) {
	render(UpdateCredentialsRow, { credentials });
	return screen.queryByTestId("update-credentials");
}

function badge(): HTMLElement {
	return screen.getByTestId("update-credentials-state");
}

describe("an older backend", () => {
	it("an absent credentials block renders nothing at all", () => {
		const { container } = render(UpdateCredentialsRow, {
			credentials: undefined,
		});
		expect(screen.queryByTestId("update-credentials")).toBeNull();
		expect(container.textContent?.trim()).toBe("");
	});

	it("the Connection section without the field keeps its old content and no row", () => {
		render(ConnectionSection, { transport: null });
		expect(screen.getByTestId("updates-connection")).toBeTruthy();
		expect(screen.getByTestId("update-connection-none")).toBeTruthy();
		expect(screen.queryByTestId("update-credentials")).toBeNull();
	});
});

describe("each device verdict", () => {
	it("valid: positive badge and the localized expiry date, no countdown", () => {
		const expiresAt = NOW + 400 * DAY_MS;
		const shown = row({ expiresAt, state: "valid" });
		expect(shown?.getAttribute("data-state")).toBe("valid");
		expect(badge().textContent?.trim()).toBe("Valid");
		expect(badge().getAttribute("data-status-badge")).toBe("success");
		expect(screen.getByTestId("update-credentials-date").textContent).toContain(
			`Expires ${formatUpdateTime(expiresAt, "en")}`,
		);
		expect(screen.queryByTestId("update-credentials-remaining")).toBeNull();
	});

	it.each([90, 30, 7])(
		"expiring with exactly %i days left: warning badge and 'in about %i days'",
		(days) => {
			row({ expiresAt: NOW + days * DAY_MS, state: "expiring" });
			expect(badge().textContent?.trim()).toBe("Expiring soon");
			expect(badge().getAttribute("data-status-badge")).toBe("warning");
			expect(
				screen.getByTestId("update-credentials-remaining").textContent?.trim(),
			).toBe(`in about ${days} days`);
		},
	);

	it("expiring with one day and a bit left reads in the singular", () => {
		row({ expiresAt: NOW + DAY_MS + 3_600_000, state: "expiring" });
		expect(
			screen.getByTestId("update-credentials-remaining").textContent?.trim(),
		).toBe("in about 1 day");
	});

	it("expiring with under a day left never says 'about 0 days'", () => {
		row({ expiresAt: NOW + 3_600_000, state: "expiring" });
		expect(
			screen.getByTestId("update-credentials-remaining").textContent?.trim(),
		).toBe("in less than a day");
	});

	it("expiring by the device but already past on this clock: no negative phrase", () => {
		row({ expiresAt: NOW - 3 * DAY_MS, state: "expiring" });
		expect(badge().textContent?.trim()).toBe("Expiring soon");
		expect(screen.queryByTestId("update-credentials-remaining")).toBeNull();
		expect(screen.getByTestId("update-credentials").textContent).not.toMatch(
			/-\s?\d|\bin -/,
		);
	});

	it("expired: error badge and the past date as 'Expired', never 'in -3 days'", () => {
		const expiresAt = NOW - 3 * DAY_MS;
		row({ expiresAt, state: "expired" });
		expect(badge().textContent?.trim()).toBe("Expired");
		expect(badge().getAttribute("data-status-badge")).toBe("error");
		expect(screen.getByTestId("update-credentials-date").textContent).toContain(
			`Expired ${formatUpdateTime(expiresAt, "en")}`,
		);
		expect(screen.queryByTestId("update-credentials-remaining")).toBeNull();
		expect(screen.getByTestId("update-credentials").textContent).not.toMatch(
			/-\s?\d/,
		);
	});

	it("unavailable: a neutral unknown, 'could not be read', never an alarm", () => {
		row({ expiresAt: null, state: "unavailable" });
		expect(badge().textContent?.trim()).toBe("Unknown");
		expect(badge().getAttribute("data-status-badge")).toBe("neutral");
		expect(
			screen.getByTestId("update-credentials-unreadable").textContent?.trim(),
		).toBe("The expiry date could not be read.");
		expect(screen.queryByTestId("update-credentials-date")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("a null expiry date", () => {
	it("a valid verdict without a date is shown as unknown, never as valid", () => {
		const shown = row({ expiresAt: null, state: "valid" });
		expect(shown?.getAttribute("data-state")).toBe("unavailable");
		expect(badge().textContent?.trim()).toBe("Unknown");
	});

	it("an expired verdict without a date keeps the alarm and says the date is unreadable", () => {
		row({ expiresAt: null, state: "expired" });
		expect(badge().textContent?.trim()).toBe("Expired");
		expect(screen.getByTestId("update-credentials-unreadable")).toBeTruthy();
	});
});

describe("structure and locale", () => {
	it("is a labelled group whose name is the row label", () => {
		row({ expiresAt: NOW + 20 * DAY_MS, state: "expiring" });
		const group = screen.getByRole("group", { name: "Update credentials" });
		expect(group.getAttribute("data-testid")).toBe("update-credentials");
	});

	it("leads the Connection section when the device reports it", () => {
		render(ConnectionSection, {
			transport: null,
			credentials: { expiresAt: NOW + 20 * DAY_MS, state: "expiring" },
		});
		const section = screen.getByTestId("updates-connection");
		const credentialsRow = screen.getByTestId("update-credentials");
		expect(section.contains(credentialsRow)).toBe(true);
		expect(
			credentialsRow.compareDocumentPosition(
				screen.getByTestId("update-connection-none"),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders Arabic copy with the locale's own date and day count", () => {
		setLocale("ar");
		const expiresAt = NOW + 12 * DAY_MS;
		row({ expiresAt, state: "expiring" });
		expect(badge().textContent?.trim()).toBe("تنتهي قريبًا");
		expect(screen.getByTestId("update-credentials-date").textContent).toContain(
			formatUpdateTime(expiresAt, "ar") as string,
		);
		const remaining =
			screen.getByTestId("update-credentials-remaining").textContent ?? "";
		expect(remaining).toContain("تقريبًا");
		expect(remaining).not.toContain("{");
	});
});
