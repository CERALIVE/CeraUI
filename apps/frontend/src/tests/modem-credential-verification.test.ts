import { resolveMessageKey } from "@ceraui/i18n/svelte";
import { modemSchema } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import captured from "../../../backend/src/tests/fixtures/modems/zte-mf79u/installed-summary.json";
import { deriveLockView } from "../lib/modem/lock-state";
import ModemLockSection from "../main/dialogs/ModemLockSection.svelte";
import { configureDisabledReasonKey } from "../main/network/cellular-row";

const calls = vi.hoisted(() => ({ set: vi.fn(), verify: vi.fn() }));
vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: { setCredentials: calls.set, verifyCredentials: calls.verify },
	},
}));
const modem = modemSchema.parse(captured.wireRowsMatchedByIdPath["1003"]);

beforeEach(() => {
	calls.set.mockReset();
	calls.verify.mockReset();
});

describe("credential verification on the captured locked router", () => {
	it.each(["admin_unreachable", "credentials_rejected"] as const)(
		"keeps the draft only in the mounted dialog after %s",
		async (verification) => {
			// Given the real captured lock and a typed failed verification reply.
			calls.set.mockResolvedValue({
				success: false,
				error: "unreachable",
				verification,
			});
			const view = render(ModemLockSection, {
				deviceId: "1003",
				lock: deriveLockView(modem),
			});
			const field = screen.getByTestId<HTMLInputElement>(
				"dongle-lock-password",
			);
			// When the operator submits a test-only credential.
			await fireEvent.input(field, { target: { value: "fixture-only-draft" } });
			await fireEvent.click(screen.getByTestId("dongle-lock-submit"));
			// Then the precise failure is visible and the draft survives only until close.
			await waitFor(() => expect(field.value).toBe("fixture-only-draft"));
			expect(
				screen.getByTestId("dongle-lock-outcome").textContent?.trim(),
			).toBe(
				resolveMessageKey(
					`network.routerCellular.lock.verification.${verification}`,
				),
			);
			expect(calls.verify).not.toHaveBeenCalled();
			expect(document.body.innerHTML).not.toContain("fixture-only-draft");
			expect(JSON.stringify(localStorage)).not.toContain("fixture-only-draft");
			expect(JSON.stringify(sessionStorage)).not.toContain(
				"fixture-only-draft",
			);
			view.unmount();
			render(ModemLockSection, {
				deviceId: "1003",
				lock: deriveLockView(modem),
			});
			expect(
				screen.getByTestId<HTMLInputElement>("dongle-lock-password").value,
			).toBe("");
		},
	);

	it("spends exactly one verification on a successful submission", async () => {
		// Given a backend that verifies as part of setCredentials.
		calls.set.mockResolvedValue({ success: true, verification: "verified" });
		render(ModemLockSection, { deviceId: "1003", lock: deriveLockView(modem) });
		// When the operator submits.
		await fireEvent.input(screen.getByTestId("dongle-lock-password"), {
			target: { value: "fixture-only-draft" },
		});
		await fireEvent.click(screen.getByTestId("dongle-lock-submit"));
		// Then no second login is dispatched and the successful draft is cleared.
		await screen.findByTestId("dongle-lock-outcome");
		expect(calls.set).toHaveBeenCalledTimes(1);
		expect(calls.verify).not.toHaveBeenCalled();
		expect(
			screen.getByTestId<HTMLInputElement>("dongle-lock-password").value,
		).toBe("");
	});

	it("keeps Configure reachable when authentication succeeded but controls were not reported", () => {
		// Given the captured router with no control block, after a successful login.
		const unlocked = { ...modem, lock_state: "unlocked" as const };
		// When deriving its Configure action, absence proves no settings write.
		const reason = configureDisabledReasonKey("router-ethernet", unlocked);
		// Then its diagnostic and vendor portal surface remains reachable.
		expect(reason).toBeUndefined();
	});
});
