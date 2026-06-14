/*
	CeraUI - Mock Constants
	Centralized magic numbers for mock data generation and thresholds
	Mirrors the pattern from modules/streaming/timing-constants.ts
*/

// ─── Relay RTT Thresholds (ms) ──────────────────────────────────────────────
// Used by relays.ts to classify relay health status
export const RELAY_RTT_GREEN_MS = 80; // 🟢 Excellent latency threshold
export const RELAY_RTT_YELLOW_MS = 150; // 🟡 Acceptable latency threshold

// ─── Bitrate Ranges (kbps) ──────────────────────────────────────────────────
// Used by mock-service.ts for streaming bitrate simulation
export const BITRATE_MIN_KBPS = 9000;
export const BITRATE_MAX_KBPS = 12000;

// ─── Signal Fluctuation Percentages ──────────────────────────────────────────
// Used by mock-service.ts applyPeriodicFluctuations() for realistic signal variations
export const MODEM_SIGNAL_FLUCTUATION_PERCENT = 5; // ±5% for modem signals
export const WIFI_SIGNAL_FLUCTUATION_PERCENT = 6; // ±6% for WiFi signals

// ─── Sensor Ranges ──────────────────────────────────────────────────────────
// Used by mock-service.ts for SoC temperature and power simulation
export const SENSOR_TEMP_BASE_IDLE_C = 48; // Base SoC temp when idle
export const SENSOR_TEMP_BASE_STREAMING_C = 58; // Base SoC temp when streaming
export const SENSOR_TEMP_FLUCTUATION_C = 10; // ±5°C variation around base
export const SENSOR_VOLTAGE_BASE_V = 4.9; // Base supply voltage
export const SENSOR_VOLTAGE_RANGE_V = 0.3; // ±0.15V variation
export const SENSOR_CURRENT_IDLE_A = 1.5; // Base current when idle
export const SENSOR_CURRENT_IDLE_RANGE_A = 0.3; // ±0.15A variation
export const SENSOR_CURRENT_STREAMING_A = 2.5; // Base current when streaming
export const SENSOR_CURRENT_STREAMING_RANGE_A = 0.5; // ±0.25A variation

// ─── Relay Population Timing ────────────────────────────────────────────────
// Used by mock-service.ts for relay cache initialization
export const MOCK_RELAY_POPULATE_DELAY_MS = 2000; // Delay before populating relay cache
export const MOCK_RTT_INTERVAL_MS = 1500; // Interval for RTT rebroadcast

// ─── SIM Lock Retry Budgets ─────────────────────────────────────────────────
// Used by the modem mock provider to seed mmcli-faithful unlock-retries counts.
export const MOCK_SIM_PIN_RETRIES = 3; // Typical PIN attempt budget
export const MOCK_SIM_PUK_RETRIES = 10; // Typical PUK attempt budget
