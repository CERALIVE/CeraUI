/*
	CeraUI - Hardware Sensors Mock Provider
	Simulates temperature, voltage, and current readings for development mode
*/

import { getSensorReadings, shouldUseMocks } from "../mock-service.ts";

/**
 * Get mock temperature reading
 * Returns value in millidegrees Celsius (as expected by sensors.ts)
 */
export function getMockTemperature(): number {
	if (!shouldUseMocks()) {
		return 0;
	}

	const sensors = getSensorReadings();
	// Return in millidegrees (multiply by 1000)
	return Math.round(sensors.socTemp * 1000);
}

/**
 * Get mock voltage reading
 * Returns value in millivolts (as expected by sensors.ts)
 */
export function getMockVoltage(): number {
	if (!shouldUseMocks()) {
		return 0;
	}

	const sensors = getSensorReadings();
	// Return in millivolts (multiply by 1000)
	return Math.round(sensors.socVoltage * 1000);
}

/**
 * Get mock current reading
 * Returns value in milliamps (as expected by sensors.ts)
 */
export function getMockCurrent(): number {
	if (!shouldUseMocks()) {
		return 0;
	}

	const sensors = getSensorReadings();
	// Return in milliamps (multiply by 1000)
	return Math.round(sensors.socCurrent * 1000);
}

/**
 * Check if we should use mock sensors
 */
export function shouldMockSensors(): boolean {
	return shouldUseMocks();
}

/**
 * Get all mock sensor readings formatted for the UI
 */
export function getMockSensorData(): Record<string, string> {
	if (!shouldUseMocks()) {
		return {};
	}

	const sensors = getSensorReadings();

	return {
		"SoC temperature": `${sensors.socTemp.toFixed(1)} °C`,
		"SoC voltage": `${sensors.socVoltage.toFixed(3)} V`,
		"SoC current": `${sensors.socCurrent.toFixed(3)} A`,
	};
}
