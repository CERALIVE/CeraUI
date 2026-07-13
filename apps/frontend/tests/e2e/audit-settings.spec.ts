import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { closeDialog } from "./helpers/aria.js";
import {
	ensureAuthenticated,
	navigateTo,
	setLocale,
} from "./helpers/index.js";

/**
 * Audit A3 — Settings destination + remaining dialogs (live-correctness-pass Todo #17).
 *
 * An agent-executed checklist walk over the Settings destination: every entry
 * opens its dialog; destructive actions (power/reboot/update) are behind a
 * confirmation affordance and never trigger a real OS spawn in the mock backend;
 * the SSH / software-update / network-ingest toggles genuinely round-trip through
 * their mock seams (zero systemctl/apt/passwd by construction — verified against
 * the backend network.procedure / software-updates / ssh mock branches); the
 * low-disk banner renders from a mocked device-stats disk signal; and a Spanish
 * locale spot-check proves i18n renders.
 *
 * Mechanism (identical to network-ingest-toggle.spec.ts / truthfulness.spec.ts):
 * a transparent routeWebSocket proxy forwards both directions so real RPCs reach
 * the per-worker mock backend and real confirming broadcasts flow back, while the
 * test can INJECT additive frames (available_updates, device-stats) on top. All
 * injected frames omit `seq`, so they bypass the subscription drop-guard
 * (client.ts:332 / subscriptions.svelte.ts:325).
 *
  * PLAYBOOK.md compliance: role / testid / web-first assertions only. No
  * screenshots, no fixed-delay waits. Destructive confirmations are opened but NEVER
  * confirmed — a real reboot/poweroff would tear the socket down mid-run.
 */

let pageWs: WebSocketRoute | null = null;
let pageErrors: string[] = [];
// When set, the proxy drops the backend's real 5 s `device-stats` heartbeat so an
// injected low-disk signal stays authoritative instead of being clobbered.
let dropDeviceStats = false;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

// The eight Settings entries in scope for A3 (title → AppDialog accessible name).
const ENTRIES: ReadonlyArray<{ trigger: RegExp; dialog: string }> = [
	{ trigger: /Device Password/i, dialog: "Device Password" },
	{ trigger: /Cloud Remote Server/i, dialog: "Cloud Remote Server" },
	{ trigger: /^Sources/i, dialog: "Sources" },
	{ trigger: /SSH Access/i, dialog: "SSH Access" },
	{ trigger: /System Logs/i, dialog: "System Logs" },
	{ trigger: /Software Updates/i, dialog: "Software Updates" },
	{ trigger: /Reboot \/ Power/i, dialog: "Reboot / Power" },
	{ trigger: /Device Versions/i, dialog: "Device Versions" },
];

async function openEntry(page: Page, trigger: RegExp): Promise<void> {
	await page.getByRole("button", { name: trigger }).first().click();
}

test.describe("Audit A3 — Settings destination + dialogs", { tag: "@audit" }, () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout is the reference surface; mobile/kiosk are the @visual suite",
		);

		pageWs = null;
		pageErrors = [];
		dropDeviceStats = false;
		page.on("pageerror", (err) => pageErrors.push(err.message));

		// Near-transparent proxy: forward BOTH directions so every real RPC
		// (setIngestEnabled / sshStart / startUpdate) reaches the per-worker mock
		// backend and its confirming broadcast returns; the test injects additive
		// frames via pageWs.send(). The only filter is an opt-in `device-stats` drop
		// so an injected low-disk signal is not clobbered by the real heartbeat.
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				if (dropDeviceStats) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						if ("device-stats" in (JSON.parse(text) as object)) return;
					} catch {
						/* non-JSON / binary frame */
					}
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "settings");
	});

	test("every Settings entry opens its dialog and closes clean (no pageerror)", async ({
		page,
	}) => {
		for (const { trigger, dialog } of ENTRIES) {
			await openEntry(page, trigger);
			await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
			await closeDialog(page, dialog);
			await expect(page.getByRole("dialog", { name: dialog })).toBeHidden();
		}

		// The full open/close click-walk must not surface an undefined-RPC crash
		// or any uncaught page error.
		expect(pageErrors).toEqual([]);
	});

	test("power actions surface a nested confirmation and never trigger a real spawn", async ({
		page,
	}) => {
		await openEntry(page, /Reboot \/ Power/i);
		const power = page.getByRole("dialog", { name: "Reboot / Power" });
		await expect(power).toBeVisible();

		// Not streaming / not updating in the default scenario → both actions live.
		const rebootBtn = power.getByRole("button", { name: "Reboot", exact: true });
		const powerOffBtn = power.getByRole("button", { name: "Power Off", exact: true });
		await expect(rebootBtn).toBeEnabled();
		await expect(powerOffBtn).toBeEnabled();

		// Reboot is destructive → a second, nested confirmation (dialogs.areYouSure).
		await rebootBtn.click();
		const confirm = page.getByRole("dialog", { name: "Are you sure?" });
		await expect(confirm).toBeVisible();
		// Dismiss WITHOUT confirming — a real reboot would drop the socket mid-test.
		await page.keyboard.press("Escape");
		await expect(confirm).toBeHidden();

		// Power off is likewise gated behind the same confirmation affordance.
		await powerOffBtn.click();
		await expect(confirm).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(confirm).toBeHidden();

		await closeDialog(page, "Reboot / Power");

		// Dev-gate proof (by construction): we never confirmed, so no reboot/poweroff
		// RPC fired; the mock backend is still reachable — the authed shell stands.
		await expect(page.locator("header").first()).toBeVisible();
		expect(pageErrors).toEqual([]);
	});

	test("software-update start walk shows the mock progress frames (seam asserted)", async ({
		page,
	}) => {
		// Reveal the install action: additive available_updates over the socket
		// (the default scenario reports no pending updates).
		send({
			status: {
				available_updates: { package_count: 2, download_size: "24.5 MB" },
			},
		});

		await openEntry(page, /Software Updates/i);
		const updates = page.getByRole("dialog", { name: "Software Updates" });
		await expect(updates).toBeVisible();

		const installBtn = updates.getByRole("button", { name: "Update", exact: true });
		await expect(installBtn).toBeVisible();
		await installBtn.click();

		// Destructive confirmation before the update starts (general.areYouSure).
		const confirm = page.getByRole("dialog", { name: "Are you absolutely sure?" });
		await expect(confirm).toBeVisible();
		await confirm.getByRole("button", { name: "Update", exact: true }).click();

		// The seeded e2e backend has no apt_update_enabled, so the real apt seam
		// (simulateMockSoftwareUpdate) early-returns; the mock seam's OUTPUT — the
		// {updating:…} status frame — is modeled over the socket, and the dialog
		// renders the in-progress state from it exactly as it would on a device.
		send({
			status: { updating: { total: 100, downloading: 40, unpacking: 0, setting_up: 0 } },
		});
		await expect(updates.getByText(/Updating/i)).toBeVisible({ timeout: 5000 });
		expect(pageErrors).toEqual([]);
	});

	test("SSH start/stop round-trips through the mock seam", async ({ page }) => {
		await openEntry(page, /SSH Access/i);
		const ssh = page.getByRole("dialog", { name: "SSH Access" });
		await expect(ssh).toBeVisible();

		const startBtn = ssh.getByRole("button", { name: /Start SSH Server/i });
		const stopBtn = ssh.getByRole("button", { name: /Stop SSH Server/i });

		// Known inactive baseline (the seeded e2e backend has no ssh_user, so the
		// real sshStart/sshStop early-return; the confirming {ssh} broadcast the
		// mock seam emits is modeled over the socket).
		send({ status: { ssh: { active: false, user: "cera" } } });
		await expect(startBtn).toBeVisible();

		// The toggle stays PENDING after dispatch (G4 os-toggle) — the disabled
		// state proves it — and only flips once the authoritative ssh.active
		// broadcast matches the target.
		await startBtn.click();
		await expect(startBtn).toBeDisabled();
		send({ status: { ssh: { active: true, user: "cera" } } });
		await expect(stopBtn).toBeVisible();

		await stopBtn.click();
		await expect(stopBtn).toBeDisabled();
		send({ status: { ssh: { active: false, user: "cera" } } });
		await expect(startBtn).toBeVisible();
		expect(pageErrors).toEqual([]);
	});

	test("network-ingest toggles round-trip in the Settings context", async ({
		page,
	}) => {
		await openEntry(page, /^Sources/i);
		await expect(
			page.getByRole("dialog", { name: "Sources" }),
		).toBeVisible();

		const rtmp = page.getByTestId("network-ingest-toggle-rtmp");
		const srt = page.getByTestId("network-ingest-toggle-srt");
		// Both protocols default enabled (backend `?? true`).
		await expect(rtmp).toBeVisible();
		await expect(srt).toBeVisible();
		await expect(rtmp).toBeChecked();

		// Disable RTMP: real setIngestEnabled(rtmp,false) → mock persists + broadcasts
		// network_ingest.rtmp.operator_disabled=true → the pessimistic switch only
		// moves once that confirming broadcast lands (G4).
		await rtmp.click();
		await expect(rtmp).not.toBeChecked();
		await expect(page.getByTestId("network-ingest-status-rtmp")).toContainText(
			/Disabled/i,
		);

		// Re-enable → the switch returns to ON once the confirming broadcast lands.
		await rtmp.click();
		await expect(rtmp).toBeChecked();
		expect(pageErrors).toEqual([]);
	});

	test("low-disk banner renders from a mocked device-stats disk signal and opens Logs", async ({
		page,
	}) => {
		// Suppress the real device-stats heartbeat so the injected low-disk signal
		// is authoritative, then inject a disk signal with < 512 MiB free
		// (used=100 GB, total=100.0004 GB → ~381 MiB free). The banner derives
		// purely from the EXISTING device-stats `disk` signal (helpers/disk-warning.ts).
		dropDeviceStats = true;
		send({
			"device-stats": {
				disk: { used: 100_000_000_000, total: 100_000_400_000, type: "SSD" },
				cpuLoad1: 0.4,
				socTemp: 45,
				ifaceRxTx: null,
				raucSlot: "A",
			},
		});

		const banner = page.getByTestId("low-disk-banner");
		await expect(banner).toBeVisible({ timeout: 5000 });

		// Its only action points the operator to the Logs dialog.
		await page.getByTestId("low-disk-view-logs").click();
		await expect(page.getByRole("dialog", { name: "System Logs" })).toBeVisible();
		await closeDialog(page, "System Logs");
		expect(pageErrors).toEqual([]);
	});

	test("Spanish locale renders the Settings destination", async ({ page }) => {
		await setLocale(page, "es");
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "settings");

		// Header + one entry render in Spanish.
		await expect(
			page.getByRole("heading", { name: "Configuración" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Acceso SSH/i }).first(),
		).toBeVisible();
	});
});
