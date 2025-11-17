import type { Translation } from "../i18n-types.js";

const ar = {
	updatingOverlay: {
		title: "تحديث برامج الجهاز",
		description: "ستتمكن من استخدامه بمجرد اكتمال عملية التحديث",
		downloading: "جاري التنزيل",
		unpacking: "فك التعبئة",
		installing: "التثبيت",
		progress: "التقدم",
		successMessage: "تم التحديث بنجاح",
		successDescription:
			"يتم إعادة تشغيل الجهاز، وستتمكن من استخدامه بأحدث الميزات في غضون دقائق",
		of: "من",
		steps: "خطوات",
	},
	devtools: {
		title: "أدوات المطور",
		description: "أدوات التطوير ومكونات الاختبار (للتطوير فقط)",
		developmentMode: "وضع التطوير",
		status: "الحالة",
		active: "نشط",
		overlayDemo: "عرض توضيحي للطبقة",
		overlayDemoDescription: "اختبار مظهر ووظائف طبقة التحديث",
		startDemo: "بدء العرض التوضيحي",
		stopDemo: "إيقاف العرض التوضيحي",
		toastTester: "مختبر إشعارات Toast",
		toastTesterDescription:
			"اختبار أنواع مختلفة من إشعارات toast مع خيارات قابلة للتخصيص",
		customToast: "Toast مخصص",
		customTitle: "عنوان Toast مخصص",
		customDescription: "هذا وصف toast مخصص لأغراض الاختبار.",
		toastDuration: "المدة (ms)",
		persistent: "دائم",
		withAction: "مع إجراء",
		position: "الموضع",
		topLeft: "أعلى اليسار",
		topCenter: "أعلى الوسط",
		topRight: "أعلى اليمين",
		bottomLeft: "أسفل اليسار",
		bottomCenter: "أسفل الوسط",
		bottomRight: "أسفل اليمين",
		dismissAll: "إغلاق الكل",
		presetExamples: "أمثلة محددة مسبقاً",
		networkError: "خطأ في الشبكة",
		connectionFailed: "فشل الاتصال",
		connectionFailedDesc:
			"تعذر الاتصال بالخادم. يرجى التحقق من اتصالك بالإنترنت.",
		settingsSaved: "تم حفظ الإعدادات",
		settingsUpdated: "تم تحديث الإعدادات",
		settingsUpdatedDesc: "تم حفظ التكوين بنجاح.",
		updateAvailable: "تحديث متاح",
		newVersionAvailable: "إصدار جديد متاح",
		newVersionDesc: "تحديث البرنامج جاهز للتثبيت. هل تريد التحديث الآن؟",
		lowBattery: "بطارية منخفضة",
		batteryLow: "البطارية منخفضة",
		batteryLowDesc: "بطارية الجهاز أقل من 15%. يرجى الاتصال بالطاقة.",
		systemInfo: "معلومات النظام",
		systemInfoDescription: "بيانات النظام والبيئة في الوقت الفعلي",
		buildInformation: "معلومات البناء",
		mode: "الوضع",
		development: "التطوير",
		production: "الإنتاج",
		version: "الإصدار",
		gitCommit: "Git Commit",
		buildTime: "وقت البناء",
		apiUrl: "رابط API",
		socketPort: "منفذ المقبس",
		browserInformation: "معلومات المتصفح",
		browser: "المتصفح",
		platform: "المنصة",
		userAgent: "User Agent",
		onlineStatus: "حالة الاتصال",
		online: "متصل",
		offline: "غير متصل",
		cookies: "ملفات تعريف الارتباط",
		enabled: "مفعل",
		disabled: "معطل",
		pixelRatio: "نسبة البكسل",
		localeLanguage: "لغة التطبيق والموقع",
		currentLanguage: "اللغة الحالية",
		localeCode: "رمز المنطقة",
		browserLanguage: "لغة المتصفح",
		supportedLanguages: "اللغات المدعومة",
		clickToSwitch: "انقر للتبديل!",
		performanceMetrics: "مقاييس الأداء المباشرة",
		pageLoad: "تحميل الصفحة",
		jsMemory: "ذاكرة JS",
		viewport: "نافذة العرض",
		screen: "الشاشة",
		userPreferences: "تفضيلات المستخدم وإمكانية الوصول",
		colorScheme: "نظام الألوان",
		dark: "داكن",
		light: "فاتح",
		reducedMotion: "حركة مقلّلة",
		browserLanguages: "لغات المتصفح",
		networkInformation: "معلومات الشبكة",
		type: "النوع",
		unknown: "غير معروف",
		downlink: "الرابط النازل",
		mbps: "Mbps",
		rtt: "RTT",
		ms: "ms",
		consoleTesting: "اختبار وحدة التحكم",
		consoleTestingDesc: "اختبار مخرجات وحدة التحكم ووظائف التسجيل",
		consoleOutputTests: "اختبارات مخرجات وحدة التحكم",
		log: "سجل",
		warn: "تحذير",
		error: "خطأ",
		table: "جدول",
		developmentOnly: "للتطوير فقط",
		developmentOnlyDesc:
			"هذا التبويب ومحتواه مرئي فقط في وضع التطوير وسيتم إخفاؤه تلقائياً في بناءات الإنتاج. تذكر إزالة أي كود تصحيح قبل النشر في الإنتاج.",
		yes: "نعم",
		no: "لا",
		success: "نجح",
		warning: "تحذير",
		info: "معلومات",
		default: "افتراضي",
		loading: "جاري التحميل",
		confirmAction: "تأكيد الإجراء",
		confirmActionDesc: "هل أنت متأكد من أنك تريد حذف هذا العنصر؟",
		delete: "حذف",
		cancel: "إلغاء",
		itemDeletedSuccess: "تم حذف العنصر بنجاح!",
		actionCancelled: "تم إلغاء الإجراء",
		criticalError: "خطأ حرج",
		criticalErrorDesc: "سيستمر هذا الإشعار حتى يتم إغلاقه يدوياً.",
		dismiss: "إغلاق",
		loadingComplete: "اكتمل التحميل!",
		loadingCompleteDesc: "انتهت عملية التحميل بنجاح.",
		testingTips: "نصائح الاختبار",
		testingTipsList:
			"• جرب مدد مختلفة لاختبار توقيت الإغلاق التلقائي • اختبر تنبيهات الإجراءات للتحقق من تفاعل الأزرار • استخدم التنبيهات المستمرة لاختبار الإغلاق اليدوي • تحقق من سلوك تكديس التنبيهات المتعددة • تحقق من إمكانية الوصول مع التنقل بالكيبورد",
		dnsLookup: "البحث في نظام أسماء النطاقات",
		connect: "Connect",
		request: "Request",
		response: "Response",
		domContent: "DOM Content",
		domComplete: "DOM Complete",
		loadEvent: "Load Event",
		total: "Total",
		lastUpdated: "Last updated",
		autoRefresh: "Auto-refresh: 5s",
		demoRunning: "Demo Running",
		phase: "Phase",
		downloading: "Downloading",
		unpacking: "Unpacking",
		installing: "Installing",
		demoInfo1: "Simulates a realistic 8-second update process",
		demoInfo2: "Shows all phases: Download → Unpack → Install → Complete",
		demoInfo3: "Demonstrates the new glassmorphism design and animations",
		demoInfo4:
			"Will auto-stop after completion (remove this component in production)",
		customToastConfig: "Custom Toast Configuration",
		toastTypes: "Toast Types",
		specialToastActions: "Special Toast Actions",
		actionToast: "Action Toast",
		nodeEnv: "Node Env",
		devMode: "Dev Mode",
		clientVersion: "Client Version",
		socketEndpoint: "Socket Endpoint",
		operationCompleted: "Operation completed successfully!",
		somethingWentWrong: "Something went wrong!",
		actionCannotBeUndone: "This action cannot be undone!",
		usefulInformation: "Here is some useful information.",
		defaultToastMessage: "This is a default toast notification.",
		processingRequest: "Processing your request...",
		testingTip1: "Try different durations to test auto-dismissal timing",
		testingTip2: "Test action toasts to verify button interactions",
		testingTip3: "Use persistent toasts to test manual dismissal",
		testingTip4: "Check toast stacking behavior with multiple toasts",
		testingTip5: "Verify accessibility with keyboard navigation",
		supportedLanguagesClick: "Supported Languages ({count}) - Click to switch!",
		testDifferentTypes:
			"Test different types of toast notifications and their behaviors",
		toastNotificationTester: "Toast Notification Tester",
		livePerformanceMetrics: "Live Performance Metrics",
		userPreferencesAccessibility: "User Preferences & Accessibility",
		screenshotUtility: "📸 أداة لقطات الشاشة",
		screenshotUtilityDescription:
			"التقاط بسيط لجميع علامات التبويب والمظاهر والوضع غير المتصل",
		captureAllScreenshots: "التقاط جميع لقطات الشاشة",
		capturing: "جاري التقاط...",
		downloadZip: "تحميل ZIP ({count} ملفات)",
		clear: "مسح",
		enhancedTiming: "توقيت محسن: المحتوى مُصيَّر بالكامل قبل التقاط",
		screenshotCount:
			"سطح المكتب + الهاتف (5 علامات تبويب، موضوعان لكل منها) + غير متصل (موضوعان) = 22 إجمالي",
	},
	general: {
		status: "الحالة",
		streaming: "البث",
		offline: "غير متصل",
		temperature: "درجة الحرارة",
		relayServer: "خادم الترحيل",
		updates: "التحديثات",
		none: "لا شيء",
		youHaventConfigured: "لم تقم بتكوين أي خادم",
		port: "المنفذ",
		overview: "نظرة عامة",
		latency: "زمن الاستجابة / التأخير",
		packages: "الحزم",
		package: "حزمة",
		maxBitrate: "الحد الأقصى لمعدل البت",
		audioDevice: "جهاز الصوت",
		audioCodec: "ترميز الصوت",
		areYouSure: "هل أنت متأكد تماماً؟",
		updateButton: "تحديث",
		updateConfirmation:
			"هل أنت متأكد من رغبتك في بدء تحديث البرنامج؟ قد يستغرق هذا عدة دقائق. لن تتمكن من بدء البث حتى يكتمل. سيتم قطع اتصال جهاز الترميز لفترة وجيزة بعد الترقية الناجحة. لا تقم أبداً بإزالة الطاقة أو إعادة ضبط جهاز الترميز أثناء التحديث. إذا كان جهاز الترميز يعمل بالبطارية، فتأكد من شحنها بالكامل.",
		streamingMessage:
			"يستخدم بثك {usingNetworksCount} شبكات مع تأخير {srtLatency} مللي ثانية",
		audioSettings: "إعدادات الصوت",
		configuration: "التكوين",
		configurationNotComplete: "التكوين معلق",
		hardwareSensors: "حساسات الأجهزة",
		liveMetrics: "المقاييس المباشرة",
		networkInfo: "معلومات الشبكة",
		noSensorData: "لا توجد بيانات حساسات متاحة",
		noUpdatesAvailable: "النظام محدث",
		notAvailable: "غير متوفر",
		notConfigured: "غير مُكوّن",
		pleaseConfigureServer: "يرجى تكوين خادم الترحيل لبدء البث",
		sensors: "الحساسات",
		sensorsUnavailable: "الحساسات غير متوفرة",
		serverAndAudio: "تكوين الخادم وبث الصوت",
		serverSettings: "إعدادات الخادم",
		streamPerformance: "أداء البث",
		systemHealth: "صحة النظام",
	},
	auth: {
		createPassword: "إنشاء كلمة المرور",
		login: "تسجيل الدخول",
		createPasswordAndLogin: "إنشاء كلمة المرور وتسجيل الدخول",
		loginWithPassword: "تسجيل الدخول باستخدام كلمة المرور",
		usePassword: "استخدم كلمة مرور الجهاز للوصول إلى الوظائف",
		signIn: "تسجيل الدخول",
		rememberMe: "تذكرني",
		separatorText: "اسم الموقع",
		footerText: "ما عليك سوى تسجيل الدخول والاستمتاع بجلب الفرح",
		creatingPassword: "إنشاء كلمة المرور...",
		help: {
			createPasswordDescription:
				"ستحتاج إلى إنشاء كلمة مرور آمنة لحماية حسابك. ستُستخدم كلمة المرور هذه في جميع عمليات تسجيل الدخول المستقبلية.",
			createPasswordTitle: "الإعداد الأولي",
		},
		newPassword: "كلمة مرور جديدة",
		password: "كلمة المرور",
		placeholderNewPassword: "إنشاء كلمة مرور آمنة (8 أحرف على الأقل)",
		placeholderPassword: "أدخل كلمة المرور",
		secureAccess: "وصول آمن",
		signingIn: "جاري تسجيل الدخول...",
		validation: {
			passwordMinLength: "يجب أن تكون كلمة المرور 8 أحرف على الأقل",
			passwordValid: "كلمة المرور تبدو جيدة!",
		},
	},
	settings: {
		encoderSettings: "إعدادات المرمز",
		inputMode: "وضع الإدخال",
		djiCameraMessage:
			"قد تعمل كاميرات DJI بشكل أفضل باستخدام وضع الإدخال USB-LIBUVCH264",
		selectInputMode: "اختر وضع الإدخال",
		selectEncodingOutputFormat: "اختر ترميز الإخراج",
		encodingResolution: "دقة الترميز",
		selectEncodingResolution: "حدد دقة الترميز",
		framerate: "معدل الإطارات (FPS)",
		selectFramerate: "حدد معدل الإطارات",
		bitrate: "معدل البت (Kbps)",
		enableBitrateOverlay: "تفعيل تراكب معدل البت",
		matchDeviceResolution: "مطابقة دقة الجهاز",
		matchDeviceOutput: "مطابقة مخرجات الجهاز",
		audioSettings: "إعدادات الصوت",
		audioSource: "مصدر الصوت",
		notAvailableAudioSource: "غير متوفر",
		selectAudioSource: "حدد مصدر الصوت",
		audioCodec: "ترميز الصوت",
		selectAudioCodec: "حدد ترميز الصوت",
		audioDelay: "تأخير الصوت (مللي ثانية)",
		audioDelayEarly: "مبكر (-)",
		audioDelayLate: "متأخر (+)",
		perfectSync: "مزامنة",
		noAudioSupport: "التكوين المحدد حاليا لا يدعم أي نوع من إعدادات الصوت",
		manualConfiguration: "الإعداد اليدوي",
		receiverServer: "خادم الاستقبال",
		relayServer: "خادم الترحيل",
		relayServerAccount: "حساب خادم الترحيل",
		srtlaServerAddress: "عنوان خادم استقبال SRTLA",
		srtlaServerPort: "منفذ استقبال SRTLA",
		srtStreamId: "معرف بث SRT",
		srtLatency: "زمن استجابة SRT (مللي ثانية)",
		startStreaming: "بدء البث",
		stopStreaming: "إيقاف البث",
		changeBitrateNotice: "يمكنك تغيير معدل البت حتى أثناء البث.",
		audioSettingsMessage:
			"ستظهر إعدادات الصوت بمجرد تحديد خيار صالح في قسم الترميز",
		optional: "اختياري",
		placeholders: {
			srtlaServerAddress: "مثل: 192.168.1.100 أو server.example.com",
			srtlaServerPort: "مثل: 8890",
			srtStreamId: "مثل: stream123",
		},
		errors: {
			inputModeRequired: "يرجى تحديد وضع الإدخال",
			encoderRequired: "يرجى تحديد تنسيق الترميز",
			resolutionRequired: "يرجى تحديد دقة الترميز",
			framerateRequired: "يرجى تحديد معدل الإطارات",
			bitrateInvalid:
				"يجب أن يكون معدل البت بين 2000 و 12000 كيلوبت في الثانية",
			srtlaServerAddressRequired: "يرجى إدخال عنوان خادم SRTLA",
			srtlaServerPortRequired: "يرجى إدخال منفذ SRTLA صالح",
			relayServerRequired: "يرجى تحديد خادم الإرسال",
		},
		validation: {
			allFieldsValid: "جميع إعدادات المشفر صالحة",
		},
		completeRequiredFields: "يرجى إكمال جميع الحقول المطلوبة لتمكين البث",
		encodingFormat: "تنسيق التشفير",
		higherLatency: "أعلى",
		lowerLatency: "أقل",
		manualServerConfiguration: "تكوين الخادم اليدوي",
		noAudioSettingSupport: "لا توجد إعدادات صوتية مدعومة",
		selectPipelineFirst:
			"يرجى تحديد خط أنابيب المرمز أولاً لتكوين إعدادات الصوت",
		selectedPipelineNoAudio: "خط الأنابيب المحدد لا يدعم تكوين الصوت",
	},
	network: {
		pageTitle: "إعدادات الشبكة",
		pageDescription:
			"إدارة اتصالات WiFi والنقاط الساخنة ومودمات الخلوية وواجهات الشبكة",
		sections: {
			networkInterfaces: "واجهات الشبكة",
			wifiDevices: "أجهزة WiFi",
			cellularModems: "مودمات خلوية",
		},
		status: {
			details: "التفاصيل",
			turnOff: "إيقاف التشغيل",
			enableHotspot: "تفعيل النقطة الساخنة",
			noActiveConnection: "لا يوجد اتصال نشط",
			notConnected: "غير متصل",
			scanningNetworks: "فحص الشبكات...",
			connecting: "جاري الاتصال...",
			ready: "جاهز",
			active: "نشط",
			inactive: "غير نشط",
		},
		accessibility: {
			wifiQrCode: "رمز QR للوايفاي",
		},
		deviceCount: {
			device: "جهاز",
			devices: "أجهزة",
			modem: "مودم",
			modems: "مودمات",
		},
		emptyStates: {
			loadingStatus: "جاري تحميل حالة الشبكة...",
			pleaseWait: "يرجى الانتظار أثناء جمع معلومات الشبكة",
			noDevicesFound: "لم يتم العثور على أجهزة شبكة",
			noDevicesDescription: "لم يتم اكتشاف محولات WiFi أو مودمات خلوية",
			noNetworkInterfaces: "لا توجد واجهات شبكة متاحة",
			noNetworksDetected: "لم يتم اكتشاف شبكات",
		},
		hotspot: {
			name: "الاسم",
			channel: "القناة",
			password: "كلمة المرور",
		},
		wifi: {
			strength: "قوة الإشارة",
			ssid: "SSID",
			security: "الأمان",
			band: "النطاق",
		},
		modem: {
			signal: "الإشارة",
			status: "الحالة",
			network: "الشبكة",
			save: "حفظ",
			autoapn: "APN تلقائي",
			apn: "APN",
			username: "اسم المستخدم",
			password: "كلمة المرور",
			enableRoaming: "السماح بالتجوال",
			networkType: "نوع الشبكة",
			automaticRoamingNetwork: "اختيار تلقائي",
			roamingNetwork: "شبكة التجوال",
			scan: "فحص",
			scanning: "جاري الفحص",
			connectionStatus: {
				failed: "فشل",
				registered: "مسجل",
				enabled: "مفعّل",
				connected: "متصل",
				disconnected: "غير متصل",
				disconnecting: "جارِ الانفصال",
				connecting: "جاري الاتصال",
				scanning: "جارٍ المسح",
				searching: "البحث",
			},
			reset: "إعادة تعيين",
		},
		dialog: {
			close: "إغلاق",
			turnOff: "إيقاف",
			turnOn: "تشغيل",
			hotspotDetails: "تفاصيل نقطة الاتصال",
			turnHotspotOff: "إيقاف وضع نقطة الاتصال",
			turnHotspotOn: "تشغيل وضع نقطة الاتصال",
			turnHotspotOffDescription:
				"سيؤدي هذا إلى قطع اتصال أي عملاء متصلين على الفور وإيقاف تشغيل نقطة الاتصال.",
			turnHotspotOnDescription:
				"هل أنت متأكد من أنك تريد تشغيل وضع نقطة الاتصال؟ سيسمح ذلك بمشاركة الإنترنت الخاص بك ولكن سيقطع اتصال جميع اتصالات WiFi.",
		},
		errors: {
			networkConnectionError: "خطأ في اتصال الشبكة",
		},
		summary: {
			activeNetworks: "{active} من {total} شبكة نشطة",
			available: "متوفر",
			availableBandwidth: "إجمالي النطاق الترددي:",
			networkInfo: "معلومات الشبكة",
			networksActive:
				"{count} شبكة، {active} نشطة • الإجمالي: {total} كيلوبت/ثانية",
			totalBandwidth: "{total} كيلوبت/ثانية",
		},
		toggle: {
			disableNetwork: "تعطيل واجهة الشبكة",
			enableNetwork: "تفعيل واجهة الشبكة",
		},
	},
	hotspotConfigurator: {
		dialog: {
			save: "حفظ",
			configHotspot: "إعداد نقطة الاتصال",
			configureHotspot: "قم بتكوين نقطة الاتصال الخاصة بك",
			saving: "جاري الحفظ...",
		},
		hotspot: {
			name: "الاسم",
			password: "كلمة المرور",
			channel: "القناة",
			placeholderName: "BELABOX",
			placeholderPassword: "********",
			selectChannel: "اختر قناة",
		},
		error: {
			description: "تعذر تحديث إعدادات نقطة الاتصال. يرجى المحاولة مرة أخرى.",
			title: "فشل في التكوين",
		},
		help: {
			channelHelp: "يُنصح بالاختيار التلقائي للحصول على الأداء الأمثل",
			description:
				"قم بتكوين نقطة اتصال WiFi الشخصية الخاصة بك لمشاركة الإنترنت مع الأجهزة الأخرى.",
			nameHelp: "اختر اسماً سهل التذكر لنقطة الاتصال (3-32 حرف)",
			passwordHelp: "أنشئ كلمة مرور قوية (8-63 حرف)",
		},
		success: {
			description: "تم تحديث إعدادات نقطة الاتصال",
			title: "تم تكوين نقطة الاتصال بنجاح",
		},
		validation: {
			almostThere: "أوشكنا على الانتهاء!",
			formIncomplete: "يرجى إصلاح المشاكل المميزة للمتابعة",
			nameMaxLength: "يجب أن يكون الاسم أقل من 32 حرف",
			nameMinLength: "يجب أن يكون الاسم 3 أحرف على الأقل",
			nameValid: "الاسم يبدو جيداً",
			passwordMaxLength: "يجب أن تكون كلمة المرور أقل من 63 حرف",
			passwordMinLength: "يجب أن تكون كلمة المرور 8 أحرف على الأقل",
			passwordValid: "قوة كلمة المرور جيدة",
			readyToSave: "ممتاز! جاهز لحفظ تكوين نقطة الاتصال.",
		},
	},
	wifiSelector: {
		dialog: {
			close: "إغلاق",
			searchWifi: "البحث عن شبكات WiFi",
			availableNetworks: "الشبكات المتاحة لـ {network}",
			connecting: "جاري الاتصال",
			forgetNetwork: "نسيان شبكة WiFi",
			disconnectFrom: "قطع الاتصال من {ssid}",
			confirmForget: "هل أنت متأكد من نسيان {ssid} على شبكة {network}؟",
			connectTo: "الاتصال بـ {ssid}",
			introducePassword: "الرجاء إدخال كلمة مرور الشبكة",
			placeholderPassword: "كلمة مرور الشبكة",
		},
		button: {
			disconnect: "قطع الاتصال",
			connect: "اتصال",
			forget: "نسيان",
			scanning: "جاري المسح",
			scan: "مسح",
		},
		hotspot: {
			placeholderPassword: "********",
		},
		networks: {
			found: "شبكات موجودة",
		},
		success: {
			connected: "تم الاتصال بـ WiFi",
			connectedDescription: "تم الاتصال بنجاح بشبكة WiFi",
		},
		error: {
			connectionFailed: "فشل الاتصال بـ WiFi",
			connectionFailedDescription:
				"غير قادر على الاتصال بشبكة WiFi. الرجاء التحقق من كلمة المرور والمحاولة مرة أخرى.",
		},
		accessibility: {
			hidePassword: "إخفاء كلمة المرور",
			showPassword: "إظهار كلمة المرور",
		},
		status: {
			connected: "متصل",
		},
	},
	networking: {
		modem: {
			networkName: "اسم الشبكة",
		},
		card: {
			networkInfoTitle: "معلومات الشبكة",
			networkInfoDescription:
				"{total} شبكات، {available} متاحة، {used} مستخدمة، {bandwidth} كيلوبت/ثانية",
			identifier: "المعرّف",
		},
		toggle: {
			disableNetwork: "تعطيل الشبكة",
			enableNetwork: "تمكين الشبكة",
		},
		types: {
			hotspot: "نقطة اتصال",
			cellular: "الشبكة الخلوية",
			wifi: "WiFi",
			ethernet: "إيثرنت",
			modem: "مودم",
			usb: "يو إس بي",
		},
		labels: {
			interface: "الواجهة:",
			ipAddress: "عنوان IP:",
			bandwidth: "عرض النطاق:",
			network: "الشبكة:",
		},
	},
	networkHelper: {
		toast: {
			scanningWifi: "فحص شبكات WiFi",
			scanningWifiDescription:
				"البحث عن شبكات WiFi جديدة، قد يستغرق هذا بضع ثوانٍ",
			disconnectingWifi: "قطع اتصال WiFi",
			disconnectingWifiDescription: "قطع الاتصال من شبكة {ssid}",
			connectingWifi: "الاتصال بـ WiFi",
			connectingWifiDescription: "الاتصال بشبكة {ssid}",
			connectingNewWifi: "الاتصال بـ WiFi جديد",
			connectingNewWifiDescription: "الاتصال بشبكة {ssid}",
			wifiNetworkForgotten: "تم نسيان شبكة WiFi",
			wifiNetworkForgottenDescription: "لقد نسيت شبكة {ssid}",
		},
	},
	wifiBands: {
		band_6ghz: "6 غيغاهرتز",
		band_5ghz: "5 غيغاهرتز",
		band_2_4ghz: "2.4 غيغاهرتز",
	},
	wifiStatus: {
		disconnected: "غير متصل",
		connected: "متصل",
		hotspot: "نقطة اتصال",
	},
	navigation: {
		toggleMenu: "تبديل القائمة",
		general: "عام",
		network: "الشبكة",
		streaming: "البث",
		advanced: "متقدم",
		devtools: "أدوات التطوير",
		back: "رجوع",
	},
	advanced: {
		systemSettings: "إعدادات النظام",
		developerOptions: "خيارات المطور",
		lanPassword: "كلمة مرور واجهة الويب المحلية (belaUI)",
		lanPasswordTooltip:
			"قم بتعيين كلمة مرور لحماية الوصول إلى واجهة belaUI على الويب.",
		minLength: "الحد الأدنى للطول: 8 أحرف",
		newPassword: "كلمة المرور الجديدة",
		save: "حفظ",
		cloudRemoteKey: "مفتاح التحكم عن بعد لسحابة BELABOX",
		cloudRemoteKeyTooltip: "أدخل مفتاح التحكم عن بعد للوصول إلى سحابة BELABOX.",
		reboot: "إعادة التشغيل",
		rebootTooltip: "أعد تشغيل الجهاز لتطبيق التغييرات.",
		powerOff: "إيقاف التشغيل",
		powerOffTooltip: "أوقف تشغيل الجهاز بأمان.",
		confirmReboot: "هل تريد إعادة تشغيل الجهاز؟",
		confirmPowerOff: "هل تريد إيقاف تشغيل هذا الجهاز؟",
		sshPassword: "كلمة مرور SSH (اسم المستخدم: {sshUser})",
		sshPasswordTooltip: "استخدم كلمة المرور هذه لتسجيل الدخول عبر SSH.",
		passwordCopied: "تم نسخ كلمة المرور",
		passwordCopiedDesc: "تم نسخ كلمة مرور SSH إلى الحافظة.",
		reset: "إعادة تعيين",
		resetTooltip: "إعادة تعيين كلمة مرور SSH إلى كلمة مرور جديدة.",
		startSSH: "بدء خادم SSH",
		stopSSH: "إيقاف خادم SSH",
		sshToggleTooltip: "بدء أو إيقاف خادم SSH.",
		belaboxLog: "سجل BELABOX",
		systemLog: "سجل النظام",
		download: "تنزيل",
		belaboxLogTooltip: "تنزيل السجلات لاستكشاف الأخطاء وإصلاحها.",
		systemLogTooltip: "تنزيل سجلات النظام للتصحيح.",
		confirmBelaboxLog:
			"هل أنت متأكد من أنك تريد تنزيل سجل BELABOX؟ قد يحتوي على معلومات حساسة مثل كلمات المرور.",
		confirmSystemLog:
			"هل أنت متأكد من أنك تريد تنزيل سجل النظام؟ قد يحتوي على معلومات حساسة مثل كلمات المرور.",
		downloadBelaboxLog: "تنزيل سجل BELABOX",
		downloadSystemLog: "تنزيل سجل النظام",
		systemDescription: "إعدادات النظام المتقدمة وخيارات المطور",
		systemActions: "إجراءات النظام",
		systemActionsDescription: "عناصر التحكم في الطاقة وإعادة تشغيل النظام",
		versionInformation: "معلومات الإصدار",
		sshServer: "خادم SSH",
		active: "نشط",
		inactive: "غير نشط",
		logManagement: "إدارة السجلات",
		logManagementDescription:
			"تنزيل سجلات النظام لاستكشاف الأخطاء وإصلاحها والتصحيح",
		coreSystemConfiguration: "تكوين النظام الأساسي والأمان",
		developmentToolsAccess: "أدوات التطوير والوصول إلى النظام",
		systemComponentsVersions: "إصدارات مكونات النظام",
		applicationLogsDescription: "سجلات التطبيق والتشخيص",
		systemLogsDescription: "معلومات التصحيح على مستوى النظام",
		rebootDescription: "إعادة تشغيل النظام بأمان",
		powerOffDescription: "إيقاف تشغيل النظام بالكامل",
	},
	pwa: {
		offline: "أنت غير متصل",
		offlineDescription: "قد تكون بعض الميزات محدودة",
		connecting: "جاري الاتصال...",
		disconnected: "منقطع",
		connected: "متصل",
		installTitle: "تثبيت CeraUI",
		installDescription: "إضافة إلى الشاشة الرئيسية لتجربة أفضل",
		installLater: "لاحقاً",
		installButton: "تثبيت",
		installAndroidDescription: 'اضغط على "تثبيت" للإضافة إلى الشاشة الرئيسية',
		installAndroidMenuDescription:
			'استخدم قائمة المتصفح لـ "إضافة إلى الشاشة الرئيسية"',
		installIosDescription: 'ثم "إضافة إلى الشاشة الرئيسية"',
		installIosGotIt: "فهمت",
		refreshing: "جاري التحديث...",
		releaseToRefresh: "اترك للتحديث",
		pullToRefresh: "اسحب للتحديث",
	},
	offline: {
		title: "أنت غير متصل",
		description:
			"يحتاج CeraUI إلى اتصال بالإنترنت لإدارة جهاز BELABOX الخاص بك.",
		checkTitle: "يرجى التحقق من:",
		checkWifi: "اتصال Wi-Fi الخاص بك",
		checkNetwork: "جهازك على نفس الشبكة",
		checkDevice: "جهاز BELABOX مشغل",
		tryAgain: "حاول مرة أخرى",
		checking: "جاري التحقق...",
		checkFailed: "لا يزال غير متصل",
		goBack: "العودة",
		installNote: "يعمل هذا التطبيق بشكل أفضل عند تثبيته على جهازك",
	},
	dialog: {
		cancel: "إلغاء",
		continue: "متابعة",
	},
	theme: {
		changeTheme: "تغيير السمة",
		toggleTheme: "تبديل السمة",
		selectTheme: "اختيار السمة",
		light: "فاتح",
		dark: "داكن",
		system: "النظام",
		lightDescription: "واجهة نظيفة ومشرقة",
		darkDescription: "مريح للعينين",
		systemDescription: "اتباع إعدادات الجهاز",
	},
	locale: {
		selectLanguage: "اختيار اللغة",
	},
	version: {
		newVersionAvailable: "إصدار جديد متاح",
		newCodeVersion: "إصدار كود جديد متاح",
		newBuildVersion: "إصدار بناء جديد متاح",
		newCodeAndBuild: "كود وبناء جديد متاح",
		serverUpdated: "تم تحديث الخادم",
		refreshToUpdate: "قم بالتحديث للحصول على أحدث إصدار",
		refreshNow: "تحديث الآن",
	},
	units: {
		fps: "إطار/ثانية",
	},
} satisfies Translation;

export default ar;
