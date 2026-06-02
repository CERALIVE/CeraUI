/**
 * CeraUI dialog trigger + accessible-name catalog.
 * 14 dialogs across Live / Network / Settings destinations.
 *
 * Every entry is grounded in actual source — no invented names:
 *   • dialogName  = the `title` prop passed to AppDialog
 *                   (apps/frontend/src/lib/components/dialogs/AppDialog.svelte
 *                    renders it inside <DialogPrimitive.Title>, which sets the
 *                    dialog's accessible name via aria-labelledby).
 *   • triggerName = the visible text / aria-label of the button that opens it,
 *                   read from LiveView / NetworkView / SettingsView and the
 *                   network section components (network/*Section.svelte).
 *
 * ── Mobile verification (390px project, role="dialog") ──────────────────────
 * AppDialog renders the SAME chrome through two surfaces:
 *   • Desktop (>= 1024px): `Dialog.Content`  → ui/dialog/dialog-content.svelte
 *   • Mobile  (<  1024px): `Sheet.Content`   → ui/sheet/sheet-content.svelte
 * BOTH compose bits-ui's `Dialog` primitive (the sheet imports
 * `{ Dialog as SheetPrimitive } from 'bits-ui'`), so the surface always has
 * role="dialog", and AppDialog always renders `<DialogPrimitive.Title>{title}`.
 * Therefore `getByRole('dialog', { name })` resolves on the 390px project for
 * every entry here. Statically verified for two representative dialogs:
 *   1. EncoderDialog  — title=$LL.settings.encoderSettings() → "Encoder Settings"
 *   2. VersionsDialog — title=$LL.settings.index.versions()  → "Device Versions"
 * Both flow title → DialogPrimitive.Title → aria-labelledby on the mobile Sheet.
 *
 * ── Trigger reachability summary ────────────────────────────────────────────
 * • Settings (7): trigger <button> text IS the entry title (visible at all
 *   breakpoints) → reachable by role+name alone, NO testid required.
 * • Live (3): trigger buttons all share the label "Edit Settings" AND hide that
 *   text on mobile (`hidden sm:inline`, Pencil icon is aria-hidden) → NOT
 *   reachable by role+name. REQUIRES data-testid (added in T10).
 * • Network (4): "Configure" is reused by BOTH the cellular and ethernet
 *   sections (network.view.configure), and modem config must target the FIRST
 *   modem dynamically → REQUIRES data-testid / dynamic scoping (added in T11).
 *   "Connect" / "Set up" are header-level but can collide with per-row buttons,
 *   so they are flagged for testid scoping too.
 *
 * triggerTestId is set to the sentinel 'needs-data-testid' where the trigger is
 * NOT yet reachable by role+name; the real testid is added in T10/T11/T12.
 */

export type Destination = 'live' | 'network' | 'settings';

export interface DialogEntry {
	/** Unique key for this dialog */
	key: string;
	/** Which destination opens this dialog */
	destination: Destination;
	/** Role of the trigger control */
	triggerRole: 'button';
	/** Accessible name of the trigger control (for getByRole('button', { name })) */
	triggerName: string | RegExp;
	/** data-testid on the trigger (if role/name alone is insufficient) */
	triggerTestId?: string;
	/** Accessible name of the dialog itself (for getByRole('dialog', { name })) */
	dialogName: string | RegExp;
	/** Notes: REQUIRES data-testid, desktop/mobile behavior, special handling */
	notes: string;
}

export const DIALOG_MAP: DialogEntry[] = [
	// ── Live ────────────────────────────────────────────────────────────────
	{
		key: 'encoder',
		destination: 'live',
		triggerRole: 'button',
		triggerName: /edit settings/i, // LiveView config row Button; text "Edit Settings"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Encoder Settings', // title=$LL.settings.encoderSettings()
		notes:
			'Live view, Encoder row. REQUIRES data-testid: all 3 Live config rows share the "Edit Settings" label, and the label is `hidden sm:inline` (Pencil icon aria-hidden) so the trigger has NO accessible name on mobile (390px). Testid added in T10.',
	},
	{
		key: 'audio',
		destination: 'live',
		triggerRole: 'button',
		triggerName: /edit settings/i, // LiveView config row Button; text "Edit Settings"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Audio Settings', // title=$LL.general.audioSettings()
		notes:
			'Live view, Audio row. REQUIRES data-testid (shared "Edit Settings" label, hidden on mobile). Dialog gates on pipeline/audio support — body may show a "select pipeline first" / "no audio support" state instead of controls. Testid added in T10.',
	},
	{
		key: 'server',
		destination: 'live',
		triggerRole: 'button',
		triggerName: /edit settings/i, // LiveView config row Button; text "Edit Settings"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Receiver Server', // title=$LL.settings.receiverServer()
		notes:
			'Live view, Server row. REQUIRES data-testid (shared "Edit Settings" label, hidden on mobile). Also openable from the header server chip and the empty-state "Edit Settings" button — both unlabeled-on-mobile, so prefer the row testid. Testid added in T10.',
	},

	// ── Network ───────────────────────────────────────────────────────────────
	{
		key: 'modemConfig',
		destination: 'network',
		triggerRole: 'button',
		triggerName: /^configure$/i, // CellularSection Button; text $LL.network.view.configure() = "Configure"
		triggerTestId: 'needs-data-testid',
		dialogName: /.+/, // title={modem.name} — DYNAMIC, the modem's reported name (mock has 3 modems)
		notes:
			'Network view, Cellular section. SPECIAL CASE: locate the FIRST modem dynamically (mock has 3 modems) — do NOT use a fixed name. REQUIRES data-testid: "Configure" is reused by the Ethernet section too, so /^Configure$/ is ambiguous across sections. dialogName is the modem.name (dynamic) — assert via getByRole("dialog") then read its accessible name, or match the first modem name. Testid added in T11.',
	},
	{
		key: 'hotspot',
		destination: 'network',
		triggerRole: 'button',
		triggerName: /set up/i, // HotspotSection header Button; text $LL.network.view.setup() = "Set up"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Configure Hotspot', // title=$LL.hotspotConfigurator.dialog.configHotspot()
		notes:
			'Network view, Hotspot section header "Set up" button. The WifiSection also renders per-interface "Set up" buttons (openHotspotSetup), so /set up/i can be ambiguous — scope to the Hotspot section or use a data-testid. Testid added in T11.',
	},
	{
		key: 'wifiSelector',
		destination: 'network',
		triggerRole: 'button',
		triggerName: /^connect$/i, // WifiSection header Button; text $LL.network.view.connect() = "Connect"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Available Networks', // title=$LL.wifiSelector.dialog.availableNetworks()
		notes:
			'Network view, WiFi section header "Connect" button (targets the primary WiFi station). SPECIAL CASE: after opening, wait for scan results via a web-first assertion before interacting. Trigger only renders when a primaryWifiDevice exists. Scope or testid recommended since per-network "Connect" buttons appear inside the dialog. Testid added in T11.',
	},
	{
		key: 'netif',
		destination: 'network',
		triggerRole: 'button',
		triggerName: /^configure$/i, // EthernetSection Button; text $LL.network.view.configure() = "Configure"
		triggerTestId: 'needs-data-testid',
		dialogName: 'Configure', // title=$LL.network.view.configure() = "Configure"
		notes:
			'Network view, Ethernet section, per-interface "Configure" button. REQUIRES data-testid: shares the "Configure" label with the Cellular section (same i18n key network.view.configure), and is per-interface dynamic. NOTE dialogName "Configure" collides with the trigger label. Testid added in T11.',
	},

	// ── Settings ──────────────────────────────────────────────────────────────
	{
		key: 'devicePassword',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'Device Password', // SettingsView entry button text = entry.title = $LL.settings.index.devicePassword()
		dialogName: 'Device Password', // title=$LL.settings.index.devicePassword()
		notes:
			'Settings view, System group. Trigger <button> shows the entry title text (visible at all breakpoints) → reachable by role+name alone, no testid needed.',
	},
	{
		key: 'cloudRemote',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'Cloud Remote Server', // entry.title = $LL.settings.index.cloudRemote()
		dialogName: 'Cloud Remote Server', // title=$LL.settings.index.cloudRemote()
		notes:
			'Settings view, Streaming group. Trigger text equals dialog title → reachable by role+name alone, no testid needed.',
	},
	{
		key: 'ssh',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'SSH Access', // entry.title = $LL.settings.index.ssh()
		dialogName: 'SSH Access', // title=$LL.settings.index.ssh()
		notes:
			'Settings view, Developer group. Trigger text equals dialog title → reachable by role+name alone, no testid needed.',
	},
	{
		key: 'logs',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'System Logs', // entry.title = $LL.settings.index.logs()
		dialogName: 'System Logs', // title=$LL.settings.index.logs()
		notes:
			'Settings view, Developer group. Trigger text equals dialog title → reachable by role+name alone, no testid needed.',
	},
	{
		key: 'updates',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'Software Updates', // entry.title = $LL.settings.index.updates()
		dialogName: 'Software Updates', // title=$LL.settings.index.updates()
		notes:
			'Settings view, Software group. Trigger text equals dialog title → reachable by role+name alone. SPECIAL CASE: opening may trigger a network/update check (assert via web-first, not a fixed timeout). A nested confirm dialog uses title $LL.general.areYouSure() ("Are you sure?").',
	},
	{
		key: 'power',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'Reboot / Power', // entry.title = $LL.settings.index.power()
		dialogName: 'Reboot / Power', // title=$LL.settings.index.power()
		notes:
			'Settings view, Device group (destructive). Trigger text equals dialog title → reachable by role+name alone. SPECIAL CASE: contains destructive reboot/shutdown actions behind a nested confirm dialog (title $LL.dialogs.areYouSure() = "Are you sure?") — NEVER click the confirm button in tests.',
	},
	{
		key: 'versions',
		destination: 'settings',
		triggerRole: 'button',
		triggerName: 'Device Versions', // entry.title = $LL.settings.index.versions()
		dialogName: 'Device Versions', // title=$LL.settings.index.versions()
		notes:
			'Settings view, Device group. Info-only dialog (single close action). Trigger text equals dialog title → reachable by role+name alone, no testid needed.',
	},
];
