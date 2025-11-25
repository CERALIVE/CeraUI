/*
	CeraUI - Mock System
	Export all mock-related modules for easy access
*/

// Configuration
export {
	getActiveScenario,
	getScenarioConfig,
	isDevelopment,
	type MockScenario,
	mockModems,
	mockWifiNetworks,
	scenarios,
	setActiveScenario,
} from "./mock-config.ts";

// Service
export {
	getMockState,
	getModemSignal,
	getModemState,
	getNetworkTraffic,
	getSensorReadings,
	getStreamingStats,
	getWifiSignal,
	initMockService,
	setStreamingState,
	shouldUseMocks,
	stopMockService,
} from "./mock-service.ts";
export {
	handleMmcliCommand,
	shouldMockModems,
} from "./providers/modems.ts";
// Providers
export {
	getMockIfconfigOutput,
	shouldMockNetwork,
} from "./providers/network.ts";
export {
	getMockCurrent,
	getMockSensorData,
	getMockTemperature,
	getMockVoltage,
	shouldMockSensors,
} from "./providers/sensors.ts";
export {
	formatMockStreamingStats,
	getMockBcrpStatus,
	getMockBitrateData,
	getMockEncoderInfo,
	getMockSrtlaStats,
	getMockSrtStats,
	isStreamingScenario,
	shouldMockStreaming,
	startMockStreaming,
	stopMockStreaming,
} from "./providers/streaming.ts";
export {
	getMockHotspotChannels,
	getMockWifiInterface,
	handleNmcliCommand,
	shouldMockWifi,
} from "./providers/wifi.ts";
