/**
 * S7 native-feel guard — device-mutation async-op registration (Todo 18).
 *
 * Regression protection for the S7 "adopt-on-touch" charter standard
 * (`docs/STANDARDS-CHARTER.md`): every device-mutation action MUST route its
 * dispatch through the keyed async-operation machine (`osCommand` →
 * `beginOperation`, from `lib/rpc/async-operation.svelte.ts`) so the operator
 * gets the in-flight `pending` phase, the re-entry guard, and the single
 * failure toast — a native-feel acknowledgement instead of a dead button.
 *
 * T14 normalised all ~7 device-mutation surfaces onto `osCommand`. This guard
 * enumerates them by name and statically asserts each surface still registers
 * its async-op with the expected key. If someone removes an action's
 * `osCommand` registration (or renames its key), the matching assertion fails
 * the FE vitest CI job — no new CI step, no full component mount.
 *
 * Why a STATIC source scan and not a runtime store probe: the async-operation
 * registry is a singleton that is empty until an action actually dispatches, and
 * there is no `hasOperation`-style introspection export. Driving each of the 8
 * surfaces to dispatch would require a full Svelte mount per action with a mocked
 * subscription + RPC graph — heavy and brittle, the opposite of the lightweight
 * guard this task calls for. Scanning the source for the `osCommand` wiring is
 * self-contained, fast, and catches the exact regression we care about: an
 * action losing its async-op registration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** `apps/frontend/src/` — this test lives in `src/tests/`. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

interface DeviceAction {
	/** Human name of the device-mutation action. */
	name: string;
	/** The osCommand key the surface registers (the async-op identity). */
	key: string;
	/** Source file (relative to `src/`) that must register the async-op. */
	file: string;
	/**
	 * Tokens that ALL must appear in the source to prove the async-op for this
	 * key is wired through `osCommand`. Tailored per surface: PowerDialog
	 * dispatches reboot/poweroff via `key: action` (a variable), so its per-key
	 * proof is the `getOperationPhase('<key>')` busy-derive plus the `osCommand`
	 * call; every other surface uses a string-literal `key:`.
	 */
	mustContain: string[];
}

const POWER_DIALOG = "main/dialogs/PowerDialog.svelte";
const ON_DEVICE_DISPLAY = "main/settings/OnDeviceDisplaySection.svelte";
const SETTINGS_VIEW = "main/SettingsView.svelte";
const LIVE_VIEW = "main/LiveView.svelte";
const ADDONS_SECTION = "main/settings/AddonsSection.svelte";

/**
 * The device-mutation actions T14 wired onto `osCommand`. Each entry pins the
 * key, its owning surface, and the source tokens that prove the registration.
 */
const DEVICE_ACTIONS: readonly DeviceAction[] = [
	{
		name: "Reboot",
		key: "reboot",
		file: POWER_DIALOG,
		mustContain: ["osCommand(", "key: action", "getOperationPhase('reboot')"],
	},
	{
		name: "Power off",
		key: "poweroff",
		file: POWER_DIALOG,
		mustContain: ["osCommand(", "key: action", "getOperationPhase('poweroff')"],
	},
	{
		name: "Kiosk toggle",
		key: "kiosk",
		file: ON_DEVICE_DISPLAY,
		mustContain: ["osCommand(", "key: 'kiosk'"],
	},
	{
		name: "Kiosk configure",
		key: "kiosk-configure",
		file: ON_DEVICE_DISPLAY,
		mustContain: ["osCommand(", "key: 'kiosk-configure'"],
	},
	{
		name: "Kiosk on-screen keyboard",
		key: "kiosk-osk",
		file: ON_DEVICE_DISPLAY,
		mustContain: ["osCommand(", "key: 'kiosk-osk'"],
	},
	{
		name: "Autostart toggle",
		key: "autostart",
		file: SETTINGS_VIEW,
		mustContain: ["osCommand(", "key: 'autostart'"],
	},
	{
		name: "Switch input source",
		key: "switch-input",
		file: LIVE_VIEW,
		mustContain: ["osCommand(", "key: 'switch-input'"],
	},
	{
		name: "Add-on enable/disable",
		key: "addon:<id>",
		file: ADDONS_SECTION,
		mustContain: ["osCommand(", "key: `addon:${id}`"],
	},
] as const;

/** The canonical key set — a meta-guard so the list itself cannot silently shrink. */
const EXPECTED_KEYS: readonly string[] = [
	"reboot",
	"poweroff",
	"kiosk",
	"kiosk-configure",
	"kiosk-osk",
	"autostart",
	"switch-input",
	"addon:<id>",
];

const fileCache = new Map<string, string>();
function readSource(file: string): string {
	const abs = join(SRC_DIR, file);
	let src = fileCache.get(abs);
	if (src === undefined) {
		src = readFileSync(abs, "utf8");
		fileCache.set(abs, src);
	}
	return src;
}

describe("S7 device-mutation async-op guard", () => {
	it("enumerates exactly the expected device-mutation actions (no silent drift)", () => {
		expect([...DEVICE_ACTIONS.map((a) => a.key)].sort()).toEqual(
			[...EXPECTED_KEYS].sort(),
		);
	});

	it.each(DEVICE_ACTIONS)(
		"$name ($key) registers an async-op via osCommand in $file",
		({ key, file, mustContain }) => {
			const src = readSource(file);
			for (const token of mustContain) {
				expect(
					src.includes(token),
					`Device-mutation action "${key}" must register an async-op in ${file} ` +
						`(missing token: ${token}). S7 (docs/STANDARDS-CHARTER.md) requires every ` +
						`device-mutation action to dispatch through osCommand so the operator gets ` +
						`the in-flight pending phase, the re-entry guard, and the single failure toast.`,
				).toBe(true);
			}
		},
	);
});
