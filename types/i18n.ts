/**
 * CeraUI i18n Schema Definition
 *
 * Concrete implementation using @ceraui/i18n-typebox package
 * This file serves as the single source of truth for all CeraUI translations.
 */

import type { InferI18nSchema } from '@ceraui/i18n-typebox';
import { defineI18nSchema, TemplateLiteral, Type } from '@ceraui/i18n-typebox';

// =============================================================================
// UPDATING OVERLAY SCHEMA
// =============================================================================

const UpdatingOverlaySchema = Type.Object({
	title: Type.String(),
	description: Type.String(),
	downloading: Type.String(),
	unpacking: Type.String(),
	installing: Type.String(),
	progress: Type.String(),
	of: Type.String(),
	steps: Type.String(),
	successMessage: Type.String(),
	successDescription: Type.String(),
});

// =============================================================================
// DEVTOOLS SCHEMA (Large section - comprehensive development tools)
// =============================================================================

const DevToolsSchema = Type.Object({
	title: Type.String(),
	description: Type.String(),
	developmentMode: Type.String(),
	status: Type.String(),
	active: Type.String(),

	// Overlay Demo
	overlayDemo: Type.String(),
	overlayDemoDescription: Type.String(),
	startDemo: Type.String(),
	stopDemo: Type.String(),

	// Toast Tester
	toastTester: Type.String(),
	toastTesterDescription: Type.String(),
	customToast: Type.String(),
	customTitle: Type.String(),
	customDescription: Type.String(),
	toastDuration: Type.String(),
	persistent: Type.String(),
	withAction: Type.String(),

	// Position options
	position: Type.String(),
	topLeft: Type.String(),
	topCenter: Type.String(),
	topRight: Type.String(),
	bottomLeft: Type.String(),
	bottomCenter: Type.String(),
	bottomRight: Type.String(),
	dismissAll: Type.String(),

	// Preset examples
	presetExamples: Type.String(),
	networkError: Type.String(),
	connectionFailed: Type.String(),
	connectionFailedDesc: Type.String(),
	settingsSaved: Type.String(),
	settingsUpdated: Type.String(),
	settingsUpdatedDesc: Type.String(),
	updateAvailable: Type.String(),
	newVersionAvailable: Type.String(),
	newVersionDesc: Type.String(),
	lowBattery: Type.String(),
	batteryLow: Type.String(),
	batteryLowDesc: Type.String(),

	// System Info
	systemInfo: Type.String(),
	systemInfoDescription: Type.String(),
	buildInformation: Type.String(),
	mode: Type.String(),
	development: Type.String(),
	production: Type.String(),
	version: Type.String(),
	gitCommit: Type.String(),
	buildTime: Type.String(),
	apiUrl: Type.String(),
	socketPort: Type.String(),

	// Browser Information
	browserInformation: Type.String(),
	browser: Type.String(),
	platform: Type.String(),
	userAgent: Type.String(),
	onlineStatus: Type.String(),
	online: Type.String(),
	offline: Type.String(),
	cookies: Type.String(),
	enabled: Type.String(),
	disabled: Type.String(),
	pixelRatio: Type.String(),

	// Locale & Language
	localeLanguage: Type.String(),
	currentLanguage: Type.String(),
	localeCode: Type.String(),
	browserLanguage: Type.String(),
	supportedLanguages: Type.String(),
	clickToSwitch: Type.String(),

	// Performance Metrics
	performanceMetrics: Type.String(),
	pageLoad: Type.String(),
	jsMemory: Type.String(),
	viewport: Type.String(),
	screen: Type.String(),

	// User Preferences
	userPreferences: Type.String(),
	colorScheme: Type.String(),
	dark: Type.String(),
	light: Type.String(),
	reducedMotion: Type.String(),
	browserLanguages: Type.String(),

	// Network Information
	networkInformation: Type.String(),
	type: Type.String(),
	unknown: Type.String(),
	downlink: Type.String(),
	mbps: Type.String(),
	rtt: Type.String(),
	ms: Type.String(),

	// Console Testing
	consoleTesting: Type.String(),
	consoleTestingDesc: Type.String(),
	consoleOutputTests: Type.String(),
	log: Type.String(),
	warn: Type.String(),
	error: Type.String(),
	table: Type.String(),

	// Development Only Notice
	developmentOnly: Type.String(),
	developmentOnlyDesc: Type.String(),

	// Common responses
	yes: Type.String(),
	no: Type.String(),
	success: Type.String(),
	warning: Type.String(),
	info: Type.String(),
	default: Type.String(),
	loading: Type.String(),

	// Action confirmations
	confirmAction: Type.String(),
	confirmActionDesc: Type.String(),
	delete: Type.String(),
	cancel: Type.String(),
	itemDeletedSuccess: Type.String(),
	actionCancelled: Type.String(),
	criticalError: Type.String(),
	criticalErrorDesc: Type.String(),
	dismiss: Type.String(),
	loadingComplete: Type.String(),
	loadingCompleteDesc: Type.String(),

	// Configuration sections
	customToastConfig: Type.String(),
	toastTypes: Type.String(),
	specialToastActions: Type.String(),
	actionToast: Type.String(),

	// Additional properties (avoiding duplication from locale file)
	nodeEnv: Type.String(),
	devMode: Type.String(),
	clientVersion: Type.String(),
	socketEndpoint: Type.String(),

	// Performance timing
	dnsLookup: Type.String(),
	connect: Type.String(),
	request: Type.String(),
	response: Type.String(),
	domContent: Type.String(),
	domComplete: Type.String(),
	loadEvent: Type.String(),
	total: Type.String(),

	// Messages
	operationCompleted: Type.String(),
	somethingWentWrong: Type.String(),
	actionCannotBeUndone: Type.String(),
	usefulInformation: Type.String(),
	defaultToastMessage: Type.String(),
	processingRequest: Type.String(),

	// Testing guidance
	testingTips: Type.String(),
	testingTipsList: Type.String(),

	// Demo information
	lastUpdated: Type.String(),
	autoRefresh: Type.String(),
	demoRunning: Type.String(),
	phase: Type.String(),
	demoInfo1: Type.String(),
	demoInfo2: Type.String(),
	demoInfo3: Type.String(),
	demoInfo4: Type.String(),
	testingTip1: Type.String(),
	testingTip2: Type.String(),
	testingTip3: Type.String(),
	testingTip4: Type.String(),
	testingTip5: Type.String(),

	// Template literals with parameters
	supportedLanguagesClick: TemplateLiteral('Supported Languages ({count}) - Click to switch!'),
	testDifferentTypes: Type.String(),
	toastNotificationTester: Type.String(),
	livePerformanceMetrics: Type.String(),
	userPreferencesAccessibility: Type.String(),

	// Screenshot utility
	screenshotUtility: Type.String(),
	screenshotUtilityDescription: Type.String(),
	captureAllScreenshots: Type.String(),
	capturing: Type.String(),
	downloadZip: TemplateLiteral('Download ZIP ({count} files)'),
	clear: Type.String(),
	enhancedTiming: Type.String(),
	screenshotCount: Type.String(),
});

// =============================================================================
// GENERAL SCHEMA
// =============================================================================

const GeneralSchema = Type.Object({
	status: Type.String(),
	streaming: Type.String(),
	offline: Type.String(),
	temperature: Type.String(),
	sensors: Type.String(),
	relayServer: Type.String(),
	updates: Type.String(),
	none: Type.String(),
	notConfigured: Type.String(),
	notAvailable: Type.String(),
	youHaventConfigured: Type.String(),
	noSensorData: Type.String(),
	port: Type.String(),
	overview: Type.String(),
	configuration: Type.String(),
	latency: Type.String(),
	packages: Type.String(),
	package: Type.String(),
	maxBitrate: Type.String(),
	audioDevice: Type.String(),
	audioCodec: Type.String(),
	systemHealth: Type.String(),
	networkInfo: Type.String(),
	areYouSure: Type.String(),
	updateButton: Type.String(),
	updateConfirmation: Type.String(),
	streamingMessage: TemplateLiteral(
		'Your transmission is using {usingNetworksCount} Networks with a delay of {srtLatency} ms',
	),
	configurationNotComplete: Type.String(),
	pleaseConfigureServer: Type.String(),
	noUpdatesAvailable: Type.String(),
	serverSettings: Type.String(),
	audioSettings: Type.String(),
	hardwareSensors: Type.String(),
	streamPerformance: Type.String(),
	serverAndAudio: Type.String(),
	liveMetrics: Type.String(),
	sensorsUnavailable: Type.String(),
});

// =============================================================================
// MAIN I18N SCHEMA - ROOT OBJECT
// =============================================================================

export const CeraUISchema = defineI18nSchema(
	{
		// Core sections
		updatingOverlay: UpdatingOverlaySchema,
		devtools: DevToolsSchema,
		general: GeneralSchema,

		// Navigation
		navigation: Type.Object({
			toggleMenu: Type.String(),
			general: Type.String(),
			network: Type.String(),
			streaming: Type.String(),
			advanced: Type.String(),
			back: Type.String(),
		}),

		// Authentication
		auth: Type.Object({
			createPassword: Type.String(),
			login: Type.String(),
			createPasswordAndLogin: Type.String(),
			loginWithPassword: Type.String(),
			usePassword: Type.String(),
			password: Type.String(),
			newPassword: Type.String(),
			placeholderPassword: Type.String(),
			placeholderNewPassword: Type.String(),
			signIn: Type.String(),
			signingIn: Type.String(),
			creatingPassword: Type.String(),
			rememberMe: Type.String(),
			secureAccess: Type.String(),
			separatorText: Type.String(),
			footerText: Type.String(),
			validation: Type.Object({
				passwordMinLength: Type.String(),
				passwordValid: Type.String(),
			}),
			help: Type.Object({
				createPasswordTitle: Type.String(),
				createPasswordDescription: Type.String(),
			}),
		}),

		// Theme
		theme: Type.Object({
			changeTheme: Type.String(),
			toggleTheme: Type.String(),
			selectTheme: Type.String(),
			light: Type.String(),
			dark: Type.String(),
			system: Type.String(),
			lightDescription: Type.String(),
			darkDescription: Type.String(),
			systemDescription: Type.String(),
		}),

		// Locale
		locale: Type.Object({
			selectLanguage: Type.String(),
		}),

		// Settings (Encoder, Audio, Server Configuration)
		settings: Type.Object({
			encoderSettings: Type.String(),
			inputMode: Type.String(),
			djiCameraMessage: Type.String(),
			selectInputMode: Type.String(),
			selectEncodingOutputFormat: Type.String(),
			encodingFormat: Type.String(),
			encodingResolution: Type.String(),
			selectEncodingResolution: Type.String(),
			framerate: Type.String(),
			selectFramerate: Type.String(),
			bitrate: Type.String(),
			enableBitrateOverlay: Type.String(),
			matchDeviceResolution: Type.String(),
			matchDeviceOutput: Type.String(),
			audioSettings: Type.String(),
			audioSource: Type.String(),
			notAvailableAudioSource: Type.String(),
			selectAudioSource: Type.String(),
			audioCodec: Type.String(),
			selectAudioCodec: Type.String(),
			audioDelay: Type.String(),
			noAudioSupport: Type.String(),
			noAudioSettingSupport: Type.String(),
			selectedPipelineNoAudio: Type.String(),
			selectPipelineFirst: Type.String(),
			audioDelayEarly: Type.String(),
			audioDelayLate: Type.String(),
			perfectSync: Type.String(),
			completeRequiredFields: Type.String(),
			optional: Type.String(),
			manualServerConfiguration: Type.String(),
			lowerLatency: Type.String(),
			higherLatency: Type.String(),
			manualConfiguration: Type.String(),
			receiverServer: Type.String(),
			relayServer: Type.String(),
			relayServerAccount: Type.String(),
			srtlaServerAddress: Type.String(),
			srtlaServerPort: Type.String(),
			srtStreamId: Type.String(),
			srtLatency: Type.String(),
			startStreaming: Type.String(),
			stopStreaming: Type.String(),
			changeBitrateNotice: Type.String(),
			audioSettingsMessage: Type.String(),
			placeholders: Type.Object({
				srtlaServerAddress: Type.String(),
				srtlaServerPort: Type.String(),
				srtStreamId: Type.String(),
			}),
			errors: Type.Object({
				inputModeRequired: Type.String(),
				encoderRequired: Type.String(),
				resolutionRequired: Type.String(),
				framerateRequired: Type.String(),
				bitrateInvalid: Type.String(),
				srtlaServerAddressRequired: Type.String(),
				srtlaServerPortRequired: Type.String(),
				relayServerRequired: Type.String(),
			}),
			validation: Type.Object({
				allFieldsValid: Type.String(),
			}),
		}),

		// Network Configuration
		network: Type.Object({
			pageTitle: Type.String(),
			pageDescription: Type.String(),
			sections: Type.Object({
				networkInterfaces: Type.String(),
				wifiDevices: Type.String(),
				cellularModems: Type.String(),
			}),
			summary: Type.Object({
				networkInfo: Type.String(),
				networksActive: TemplateLiteral('{count} networks, {active} active • Total: {total} Kbps'),
				activeNetworks: TemplateLiteral('{active} of {total} networks active'),
				totalBandwidth: TemplateLiteral('{total} Kbps'),
				availableBandwidth: Type.String(),
				available: Type.String(),
			}),
			status: Type.Object({
				details: Type.String(),
				turnOff: Type.String(),
				enableHotspot: Type.String(),
				noActiveConnection: Type.String(),
				notConnected: Type.String(),
				scanningNetworks: Type.String(),
				connecting: Type.String(),
				ready: Type.String(),
				active: Type.String(),
				inactive: Type.String(),
			}),
			accessibility: Type.Object({
				wifiQrCode: Type.String(),
			}),
			deviceCount: Type.Object({
				device: Type.String(),
				devices: Type.String(),
				modem: Type.String(),
				modems: Type.String(),
			}),
			emptyStates: Type.Object({
				loadingStatus: Type.String(),
				pleaseWait: Type.String(),
				noDevicesFound: Type.String(),
				noDevicesDescription: Type.String(),
				noNetworksDetected: Type.String(),
				noNetworkInterfaces: Type.String(),
			}),
			toggle: Type.Object({
				enableNetwork: Type.String(),
				disableNetwork: Type.String(),
			}),
			errors: Type.Object({
				networkConnectionError: Type.String(),
			}),
			hotspot: Type.Object({
				name: Type.String(),
				channel: Type.String(),
				password: Type.String(),
			}),
			wifi: Type.Object({
				strength: Type.String(),
				ssid: Type.String(),
				security: Type.String(),
				band: Type.String(),
			}),
			modem: Type.Object({
				signal: Type.String(),
				status: Type.String(),
				network: Type.String(),
				save: Type.String(),
				reset: Type.String(),
				autoapn: Type.String(),
				apn: Type.String(),
				username: Type.String(),
				password: Type.String(),
				enableRoaming: Type.String(),
				networkType: Type.String(),
				automaticRoamingNetwork: Type.String(),
				roamingNetwork: Type.String(),
				scan: Type.String(),
				scanning: Type.String(),
				connectionStatus: Type.Object({
					failed: Type.String(),
					registered: Type.String(),
					enabled: Type.String(),
					connected: Type.String(),
					disconnected: Type.String(),
					disconnecting: Type.String(),
					connecting: Type.String(),
					scanning: Type.String(),
				}),
			}),
			dialog: Type.Object({
				close: Type.String(),
				turnOff: Type.String(),
				turnOn: Type.String(),
				hotspotDetails: Type.String(),
				turnHotspotOff: Type.String(),
				turnHotspotOn: Type.String(),
				turnHotspotOffDescription: Type.String(),
				turnHotspotOnDescription: Type.String(),
			}),
		}),

		// Hotspot Configuration
		hotspotConfigurator: Type.Object({
			dialog: Type.Object({
				save: Type.String(),
				saving: Type.String(),
				configHotspot: Type.String(),
				configureHotspot: Type.String(),
			}),
			hotspot: Type.Object({
				name: Type.String(),
				password: Type.String(),
				channel: Type.String(),
				placeholderName: Type.String(),
				placeholderPassword: Type.String(),
				selectChannel: Type.String(),
			}),
			validation: Type.Object({
				nameMinLength: Type.String(),
				nameMaxLength: Type.String(),
				nameValid: Type.String(),
				passwordMinLength: Type.String(),
				passwordMaxLength: Type.String(),
				passwordValid: Type.String(),
				formIncomplete: Type.String(),
				almostThere: Type.String(),
				readyToSave: Type.String(),
			}),
			help: Type.Object({
				nameHelp: Type.String(),
				passwordHelp: Type.String(),
				channelHelp: Type.String(),
				description: Type.String(),
			}),
			success: Type.Object({
				title: Type.String(),
				description: Type.String(),
			}),
			error: Type.Object({
				title: Type.String(),
				description: Type.String(),
			}),
		}),

		// WiFi Selector
		wifiSelector: Type.Object({
			dialog: Type.Object({
				close: Type.String(),
				searchWifi: Type.String(),
				availableNetworks: Type.String(),
				connecting: Type.String(),
				forgetNetwork: Type.String(),
				disconnectFrom: Type.String(),
				confirmForget: TemplateLiteral('Are you sure to forget {ssid} on the {network} network?'),
				connectTo: Type.String(),
				introducePassword: Type.String(),
				placeholderPassword: Type.String(),
			}),
			button: Type.Object({
				disconnect: Type.String(),
				connect: Type.String(),
				forget: Type.String(),
				scanning: Type.String(),
				scan: Type.String(),
			}),
			hotspot: Type.Object({
				placeholderPassword: Type.String(),
			}),
			networks: Type.Object({
				found: Type.String(),
			}),
			status: Type.Object({
				connected: Type.String(),
			}),
			success: Type.Object({
				connected: Type.String(),
				connectedDescription: Type.String(),
			}),
			error: Type.Object({
				connectionFailed: Type.String(),
				connectionFailedDescription: Type.String(),
			}),
			accessibility: Type.Object({
				hidePassword: Type.String(),
				showPassword: Type.String(),
			}),
		}),

		// Additional networking sections
		networking: Type.Object({
			modem: Type.Object({
				networkName: Type.String(),
			}),
			card: Type.Object({
				networkInfoTitle: Type.String(),
				networkInfoDescription: TemplateLiteral(
					'{total} Networks, {available} Available, {used} Used, {bandwidth} Kbps',
				),
				identifier: Type.String(),
			}),
			toggle: Type.Object({
				disableNetwork: Type.String(),
				enableNetwork: Type.String(),
			}),
			types: Type.Object({
				hotspot: Type.String(),
				cellular: Type.String(),
				wifi: Type.String(),
				ethernet: Type.String(),
				modem: Type.String(),
				usb: Type.String(),
			}),
			labels: Type.Object({
				interface: Type.String(),
				ipAddress: Type.String(),
				bandwidth: Type.String(),
				network: Type.String(),
			}),
		}),

		// Network Helper (Toast messages)
		networkHelper: Type.Object({
			toast: Type.Object({
				scanningWifi: Type.String(),
				scanningWifiDescription: Type.String(),
				disconnectingWifi: Type.String(),
				disconnectingWifiDescription: TemplateLiteral('Disconnecting from the {ssid} network'),
				connectingWifi: Type.String(),
				connectingWifiDescription: TemplateLiteral('Connecting to the {ssid} network'),
				connectingNewWifi: Type.String(),
				connectingNewWifiDescription: TemplateLiteral('Connecting to the {ssid} network'),
				wifiNetworkForgotten: Type.String(),
				wifiNetworkForgottenDescription: TemplateLiteral('You have forgotten the {ssid} network'),
			}),
		}),

		// WiFi Bands & Status
		wifiBands: Type.Object({
			band_6ghz: Type.String(),
			band_5ghz: Type.String(),
			band_2_4ghz: Type.String(),
		}),

		wifiStatus: Type.Object({
			disconnected: Type.String(),
			connected: Type.String(),
			hotspot: Type.String(),
		}),

		// Advanced Settings
		advanced: Type.Object({
			systemSettings: Type.String(),
			developerOptions: Type.String(),
			lanPassword: Type.String(),
			lanPasswordTooltip: Type.String(),
			minLength: Type.String(),
			newPassword: Type.String(),
			save: Type.String(),
			cloudRemoteKey: Type.String(),
			cloudRemoteKeyTooltip: Type.String(),
			reboot: Type.String(),
			rebootTooltip: Type.String(),
			powerOff: Type.String(),
			powerOffTooltip: Type.String(),
			confirmReboot: Type.String(),
			confirmPowerOff: Type.String(),
			sshPassword: TemplateLiteral('SSH Password (User Name: {sshUser})'),
			sshPasswordTooltip: Type.String(),
			passwordCopied: Type.String(),
			passwordCopiedDesc: Type.String(),
			reset: Type.String(),
			resetTooltip: Type.String(),
			startSSH: Type.String(),
			stopSSH: Type.String(),
			sshToggleTooltip: Type.String(),
			belaboxLog: Type.String(),
			systemLog: Type.String(),
			download: Type.String(),
			belaboxLogTooltip: Type.String(),
			systemLogTooltip: Type.String(),
			confirmBelaboxLog: Type.String(),
			confirmSystemLog: Type.String(),
			downloadBelaboxLog: Type.String(),
			downloadSystemLog: Type.String(),
			systemDescription: Type.String(),
			systemActions: Type.String(),
			systemActionsDescription: Type.String(),
			versionInformation: Type.String(),
			sshServer: Type.String(),
			active: Type.String(),
			inactive: Type.String(),
			logManagement: Type.String(),
			logManagementDescription: Type.String(),
			coreSystemConfiguration: Type.String(),
			developmentToolsAccess: Type.String(),
			systemComponentsVersions: Type.String(),
			applicationLogsDescription: Type.String(),
			systemLogsDescription: Type.String(),
			rebootDescription: Type.String(),
			powerOffDescription: Type.String(),
		}),

		// PWA (Progressive Web App)
		pwa: Type.Object({
			offline: Type.String(),
			offlineDescription: Type.String(),
			connecting: Type.String(),
			disconnected: Type.String(),
			connected: Type.String(),
			installTitle: Type.String(),
			installDescription: Type.String(),
			installLater: Type.String(),
			installButton: Type.String(),
			installAndroidDescription: Type.String(),
			installAndroidMenuDescription: Type.String(),
			installIosDescription: Type.String(),
			installIosGotIt: Type.String(),
			refreshing: Type.String(),
			releaseToRefresh: Type.String(),
			pullToRefresh: Type.String(),
		}),

		// Offline state
		offline: Type.Object({
			title: Type.String(),
			description: Type.String(),
			checkTitle: Type.String(),
			checkWifi: Type.String(),
			checkNetwork: Type.String(),
			checkDevice: Type.String(),
			tryAgain: Type.String(),
			checking: Type.String(),
			checkFailed: Type.String(),
			goBack: Type.String(),
			installNote: Type.String(),
		}),

		// Dialog components
		dialog: Type.Object({
			cancel: Type.String(),
			continue: Type.String(),
		}),

		// Units
		units: Type.Object({
			fps: Type.String(),
		}),

		// Version management
		version: Type.Object({
			newVersionAvailable: Type.String(),
			newCodeVersion: Type.String(),
			newBuildVersion: Type.String(),
			newCodeAndBuild: Type.String(),
			serverUpdated: Type.String(),
			refreshToUpdate: Type.String(),
			refreshNow: Type.String(),
		}),
	},
	{
		title: 'CeraUI Translation Schema',
		description: 'Complete translation structure for CeraUI application',
	},
);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type CeraUIKeys = InferI18nSchema<typeof CeraUISchema>;
export type { DeepKeyPath, DeepKeyPath, DeepKeyPath } from '@ceraui/i18n-typebox';
export type CeraUIKeys = InferI18nSchema<typeof CeraUISchema>;
export type CeraUIKeys = InferI18nSchema<typeof CeraUISchema>;
