/*
	CeraUI - Modem Mock Provider
	Simulates mmcli (ModemManager) output for development mode
*/

import type {
	SimPukUnlockResult,
	SimUnlockResult,
} from "../../modules/modems/mmcli.ts";
import type { LockedModem } from "../../modules/modems/sim-autounlock.ts";
import {
	MOCK_SIM_PIN_RETRIES,
	MOCK_SIM_PUK_RETRIES,
} from "../mock-constants.ts";
import type { MockSimLock, MockSimState } from "../mock-schemas.ts";
import {
	getMockState,
	getModemSignal,
	getModemState,
	getScenarioConfig,
	mockModems,
	setMockSimPinSecret,
	setMockSimState,
	shouldUseMocks,
} from "../mock-service.ts";

export type { MockSimLock };

/** Label ("5g4g") → mmcli mode fields; ordering must mirror mmConvertNetworkType (mmcli.ts). */
function buildModesFromType(type: string): {
	allowed: string;
	preferred: string;
	accessTech: string;
} {
	const gens = (type.match(/\d+g/gi) ?? []).map((g) => g.toLowerCase());
	const ordered = [...new Set(gens)].sort();
	const allowed = ordered.length > 0 ? ordered.join(", ") : "4g";
	const highest = ordered[ordered.length - 1] ?? "4g";
	const preferred = ordered.length > 1 ? highest : "none";
	const accessTech =
		highest === "5g" ? "5gnr" : highest === "3g" ? "umts" : "lte";
	return { allowed, preferred, accessTech };
}

/**
 * Parse mmcli command arguments and return appropriate mock response
 */
export function handleMmcliCommand(args: string[]): string | null {
	if (!shouldUseMocks()) {
		return null;
	}

	// mmcli -K -L (list modems)
	if (args.includes("-L")) {
		return getMockModemList();
	}

	// mmcli -K -m <id> (get modem info)
	const modemIndex = args.indexOf("-m");
	if (modemIndex !== -1 && args[modemIndex + 1]) {
		const modemId = Number.parseInt(args[modemIndex + 1], 10);

		// Check for 3gpp-scan flag
		if (args.includes("--3gpp-scan")) {
			return getMockNetworkScan(modemId);
		}

		return getMockModemInfo(modemId);
	}

	// mmcli -K -i <id> (get SIM info)
	const simIndex = args.indexOf("-i");
	if (simIndex !== -1 && args[simIndex + 1]) {
		const simId = Number.parseInt(args[simIndex + 1], 10);
		return getMockSimInfo(simId);
	}

	return null;
}

/**
 * Generate mock modem list output
 */
function getMockModemList(): string {
	const config = getScenarioConfig();
	const lines: string[] = [];

	lines.push(`modem-list.length: ${config.modems}`);

	for (let i = 0; i < config.modems; i++) {
		lines.push(
			`modem-list.value[${i}]: /org/freedesktop/ModemManager1/Modem/${i}`,
		);
	}

	return lines.join("\n");
}

/**
 * Generate mock modem info output
 */
function getMockModemInfo(modemId: number): string {
	const config = getScenarioConfig();

	if (modemId >= config.modems) {
		return "";
	}

	const modem = mockModems[modemId];
	if (!modem) {
		return "";
	}

	const saved = getMockState().modemConfigs.get(String(modemId));
	const activeNetworkType =
		saved?.network_type_active ?? modem.network_type.active;
	const roaming = saved?.roaming ?? false;
	const { allowed, preferred, accessTech } =
		buildModesFromType(activeNetworkType);
	const is5g = accessTech === "5gnr";

	const sim = getMockSimState(modemId);
	const simLock: MockSimLock = sim?.lock ?? "unlocked";
	const unlockRequired =
		simLock === "pin-locked"
			? "sim-pin"
			: simLock === "puk-locked"
				? "sim-puk"
				: "none";
	const unlockRetries = [
		`sim-pin (${sim?.pinRetries ?? MOCK_SIM_PIN_RETRIES})`,
		`sim-puk (${sim?.pukRetries ?? MOCK_SIM_PUK_RETRIES})`,
	];

	const signal = Math.round(getModemSignal(modemId));
	const state = getModemState(modemId);
	const registrationState =
		state === "connected"
			? roaming
				? "roaming"
				: "home"
			: state === "registered"
				? "roaming"
				: "searching";

	// Generate per-model supported modes based on network_type.supported
	const supportedModes: string[] = [];
	const supportedTypes = modem.network_type.supported;

	// Build mode combinations from supported types
	if (supportedTypes.includes("4g") && !supportedTypes.includes("5g")) {
		// 4G only (e.g., EM7455)
		supportedModes.push("allowed: 4g; preferred: none");
	} else if (supportedTypes.includes("5g")) {
		// 5G capable (e.g., RM520N-GL, RM500Q-GL)
		supportedModes.push("allowed: 4g; preferred: none");
		supportedModes.push("allowed: 4g, 5g; preferred: 5g");
		supportedModes.push("allowed: 5g; preferred: none");
	}

	const lines: string[] = [
		`modem.dbus-path: /org/freedesktop/ModemManager1/Modem/${modemId}`,
		`modem.generic.device-identifier: ${modem.imei.slice(0, 8)}`,
		`modem.generic.manufacturer: ${modem.manufacturer}`,
		`modem.generic.model: ${modem.model}`,
		`modem.generic.revision: ${is5g ? "RM520NGLAAR01A07M4G" : "SWI9X30C_02.33.03.00"}`,
		`modem.generic.carrier-configuration: default`,
		`modem.generic.carrier-configuration-revision: --`,
		`modem.generic.hardware-revision: --`,
		`modem.generic.equipment-identifier: ${modem.imei}`,
		`modem.generic.device: /sys/devices/platform/usb/usb${modemId + 1}`,
		`modem.generic.drivers.length: 2`,
		`modem.generic.drivers.value[0]: qmi_wwan`,
		`modem.generic.drivers.value[1]: option`,
		`modem.generic.plugin: ${modem.manufacturer}`,
		`modem.generic.primary-port: cdc-wdm${modemId}`,
		`modem.generic.ports.length: 4`,
		`modem.generic.ports.value[0]: cdc-wdm${modemId} (qmi)`,
		`modem.generic.ports.value[1]: ttyUSB${modemId * 3} (at)`,
		`modem.generic.ports.value[2]: ttyUSB${modemId * 3 + 1} (at)`,
		`modem.generic.ports.value[3]: ${modem.interfaceName} (net)`,
		`modem.generic.state: ${state}`,
		`modem.generic.state-failed-reason: --`,
		`modem.generic.power-state: on`,
		`modem.generic.unlock-required: ${unlockRequired}`,
		`modem.generic.unlock-retries.length: ${unlockRetries.length}`,
		...unlockRetries.map(
			(entry, idx) => `modem.generic.unlock-retries.value[${idx}]: ${entry}`,
		),
		`modem.generic.access-technologies.length: 1`,
		`modem.generic.access-technologies.value[0]: ${accessTech}`,
		`modem.generic.signal-quality.value: ${signal}`,
		`modem.generic.signal-quality.recent: yes`,
		`modem.generic.supported-modes.length: ${supportedModes.length}`,
		...supportedModes.map(
			(mode, idx) => `modem.generic.supported-modes.value[${idx}]: ${mode}`,
		),
		`modem.generic.current-modes: allowed: ${allowed}; preferred: ${preferred}`,
		`modem.generic.supported-bands.length: 20`,
		`modem.generic.current-bands.length: 15`,
		`modem.generic.supported-ip-families: ipv4, ipv6, ipv4v6`,
		`modem.generic.sim: /org/freedesktop/ModemManager1/SIM/${modemId}`,
		`modem.generic.sim-slots.length: 1`,
		`modem.generic.sim-slots.value[0]: /org/freedesktop/ModemManager1/SIM/${modemId}`,
		`modem.generic.primary-sim-slot: 1`,
		`modem.3gpp.imei: ${modem.imei}`,
		`modem.3gpp.registration-state: ${registrationState}`,
		`modem.3gpp.operator-code: ${modem.operatorCode}`,
		`modem.3gpp.operator-name: ${modem.carrier}`,
		`modem.3gpp.packet-service-state: attached`,
		`modem.3gpp.eps-ue-mode-operation: csps-2`,
		`modem.3gpp.pco: --`,
	];

	return lines.join("\n");
}

/**
 * Generate mock SIM info output
 */
function getMockSimInfo(simId: number): string {
	const config = getScenarioConfig();

	if (simId >= config.modems) {
		return "";
	}

	const modem = mockModems[simId];
	if (!modem) {
		return "";
	}

	const lines: string[] = [
		`sim.dbus-path: /org/freedesktop/ModemManager1/SIM/${simId}`,
		`sim.properties.active: yes`,
		`sim.properties.iccid: ${modem.iccid}`,
		`sim.properties.imsi: ${modem.iccid.slice(0, 15)}`,
		`sim.properties.eid: --`,
		`sim.properties.operator-code: ${modem.operatorCode}`,
		`sim.properties.operator-name: ${modem.carrier}`,
		`sim.properties.emergency-numbers.length: 3`,
		`sim.properties.emergency-numbers.value[0]: 911`,
		`sim.properties.emergency-numbers.value[1]: 112`,
		`sim.properties.emergency-numbers.value[2]: 000`,
		`sim.properties.preferred-networks.length: 0`,
	];

	return lines.join("\n");
}

/**
 * Generate mock network scan results
 */
function getMockNetworkScan(modemId: number): string {
	const config = getScenarioConfig();

	if (modemId >= config.modems) {
		return "";
	}

	const modem = mockModems[modemId];
	if (!modem) {
		return "";
	}

	// Generate some available networks
	const networks = [
		{ code: modem.operatorCode, name: modem.carrier, status: "current" },
		{ code: "310260", name: "T-Mobile", status: "available" },
		{ code: "310410", name: "AT&T", status: "available" },
		{ code: "311480", name: "Verizon", status: "available" },
	];

	const lines: string[] = [
		`modem.3gpp.scan-networks.length: ${networks.length}`,
	];

	for (let i = 0; i < networks.length; i++) {
		const net = networks[i];
		lines.push(
			`modem.3gpp.scan-networks.value[${i}]: operator-code: ${net?.code}, operator-name: ${net?.name}, availability: ${net?.status}`,
		);
	}

	return lines.join("\n");
}

/**
 * Check if we should mock modem commands
 */
export function shouldMockModems(): boolean {
	return shouldUseMocks();
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock SIM lock state machine
//
// Deterministic stand-ins for the boot SIM-PIN auto-unlock + SIM PUK recovery
// flows. The mmcli mock above reports each modem's lock via
// `modem.generic.unlock-required`/`unlock-retries`; the helpers here drive that
// state and provide the injectable surface the auto-unlock contract test wires
// into SimAutoUnlockDeps — so the once-then-stop / no-PUK-loop behaviour is
// exercised with no hardware and no /run access.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixture PIN the mock tmpfs secret "stores" for the opt-in auto-unlock path.
 * CLEARLY NOT A REAL PIN — a well-known dev/test value, never a credential, and
 * redacted by the logger's `pin` key/value scrub if it ever reaches a log line.
 */
export const MOCK_SIM_PIN_FIXTURE = "0000";

function modemPathToId(modemPath: string): number | null {
	const m = modemPath.match(/(\d+)$/);
	return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

export function getMockSimState(modemId: number): MockSimState | undefined {
	return getMockState().simStates.get(String(modemId));
}

/**
 * Controllable transition for tests/dev: set a modem's SIM lock state, reseeding
 * the retry budgets so the mock mmcli output and the unlock state machine start
 * from a faithful count (PUK-locked implies the PIN budget is already spent).
 */
export function setMockSimLockState(modemId: number, lock: MockSimLock): void {
	setMockSimState(String(modemId), {
		lock,
		pinRetries: lock === "puk-locked" ? 0 : MOCK_SIM_PIN_RETRIES,
		pukRetries: MOCK_SIM_PUK_RETRIES,
	});
}

/** Mock the chmod-600 tmpfs PIN secret read — returns the in-memory stand-in, never touches /run. */
export function mockLoadSimPinSecret(): string | null {
	return getMockState().simPinSecret;
}

/** Mock clearing the stored PIN secret (the auto-unlock SIM-lockout guard). */
export function mockClearSimPinSecret(): void {
	setMockSimPinSecret(null);
}

/** Enumerate the modems the mock currently reports as SIM-PIN locked, in the LockedModem shape the boot auto-unlock consumes. */
export function getMockPinLockedModems(): Array<LockedModem> {
	const config = getScenarioConfig();
	const locked: Array<LockedModem> = [];
	for (let i = 0; i < config.modems; i++) {
		if (getMockSimState(i)?.lock === "pin-locked") {
			locked.push({ id: i, path: String(i) });
		}
	}
	return locked;
}

/**
 * Mock a SINGLE SIM-PIN submit, classified exactly like the real `unlockSimPin`:
 * a PUK lock surfaces `puk-required` without ever submitting; the correct fixture
 * PIN unlocks; a wrong PIN burns one attempt and trips the SIM to PUK once the
 * budget hits zero. This performs ONE attempt only — the boot hook's
 * once-then-stop contract is what guarantees it is never looped toward a lockout.
 */
export function mockAttemptSimUnlock(
	modemPath: string,
	pin: string,
): SimUnlockResult {
	const modemId = modemPathToId(modemPath);
	if (modemId === null) {
		return { state: "error" };
	}
	const sim = getMockSimState(modemId);
	if (!sim) {
		return { state: "error" };
	}

	if (sim.lock === "puk-locked") {
		return { state: "puk-required" };
	}
	if (sim.lock !== "pin-locked") {
		return { state: "no-locked-modem" };
	}

	if (pin === MOCK_SIM_PIN_FIXTURE) {
		setMockSimLockState(modemId, "unlocked");
		return { state: "success" };
	}

	const pinRetries = Math.max(0, sim.pinRetries - 1);
	if (pinRetries === 0) {
		setMockSimState(String(modemId), { lock: "puk-locked", pinRetries: 0 });
		return { state: "puk-required" };
	}
	setMockSimState(String(modemId), { lock: "pin-locked", pinRetries });
	return { state: "wrong-pin", remainingAttempts: pinRetries };
}

/**
 * Fixture PUK the mock "accepts" on the SIM PUK recovery path. CLEARLY NOT A REAL
 * PUK — a well-known dev/test value (the 8-digit shape mmcli enforces), never a
 * credential, and redacted by the logger's `puk`/`secret` scrub if it ever reaches
 * a log line.
 */
export const MOCK_SIM_PUK_FIXTURE = "12345678";

/**
 * Mock a SINGLE SIM-PUK submit, classified exactly like the real `unlockSimPuk`:
 * a SIM that is not PUK-locked surfaces `no-locked-modem` without ever submitting;
 * the correct fixture PUK clears the lock; a wrong PUK burns one attempt and
 * bricks the SIM (`locked`) once the PUK budget hits zero. This performs ONE
 * attempt only — like the PIN mock, the never-loop contract lives in the caller.
 *
 * The deterministic stand-in for the SIM PUK recovery UI's terminal states
 * (success / wrong-puk / locked / no-locked-modem), so the frontend PUK flow can
 * be exercised with no PUK-locked hardware.
 */
export function mockAttemptSimPukUnlock(
	modemPath: string,
	puk: string,
): SimPukUnlockResult {
	const modemId = modemPathToId(modemPath);
	if (modemId === null) {
		return { success: false, error: "error" };
	}
	const sim = getMockSimState(modemId);
	if (!sim) {
		return { success: false, error: "error" };
	}

	if (sim.lock !== "puk-locked") {
		return { success: false, error: "no-locked-modem" };
	}

	if (puk === MOCK_SIM_PUK_FIXTURE) {
		setMockSimLockState(modemId, "unlocked");
		return { success: true };
	}

	const pukRetries = Math.max(0, sim.pukRetries - 1);
	if (pukRetries === 0) {
		setMockSimState(String(modemId), { lock: "puk-locked", pukRetries: 0 });
		return { success: false, error: "locked", remainingAttempts: 0 };
	}
	setMockSimState(String(modemId), { lock: "puk-locked", pukRetries });
	return { success: false, error: "wrong-puk", remainingAttempts: pukRetries };
}
