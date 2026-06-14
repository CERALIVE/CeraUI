/*
	CeraUI - Mock System
	Export all mock-related modules for easy access
*/

// Fixture factory (parameterized builders)
export {
	buildMockAddonDescriptor,
	buildMockAddonState,
	buildMockKioskToken,
	buildMockModem,
	buildMockRelay,
	buildMockSimState,
	buildMockWifiNetwork,
	buildMockWifiRadio,
} from "./fixture-factory.ts";
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
	getMockAddons,
	getMockState,
	getModemSignal,
	getModemState,
	getNetworkTraffic,
	getSensorReadings,
	getStreamingStats,
	getWifiSignal,
	initMockService,
	type MockState,
	removeMockAddonState,
	resetMockState,
	setMockAddonState,
	setStreamingState,
	shouldUseMocks,
	stopMockService,
	updateMockState,
} from "./mock-service.ts";
export {
	createMockAddonManagerDeps,
	createMockReconcilerDeps,
	MOCK_ADDON_UNIT,
	MockAddonDescriptor,
	type MockAddonManagerHarness,
	type MockAddonManagerRecorder,
	type MockAddonManagerSignals,
	MockAddonState,
	type MockReconcilerHarness,
	type MockReconcilerRecorder,
	type MockReconcilerSignals,
} from "./providers/addons.ts";
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
	type CerastreamTier2Error,
	clearMockStreamError,
	formatMockStreamingStats,
	getInjectedMockStreamError,
	getMockBcrpStatus,
	getMockBitrateData,
	getMockEncoderInfo,
	getMockSrtlaStats,
	getMockSrtStats,
	injectMockStreamError,
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
