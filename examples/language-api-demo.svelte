<script lang="ts">
  import { i18n } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // 🌍 COMPLETE LANGUAGE API DEMONSTRATION
  // =============================================================================

  let output = $state<string[]>([]);
  let isLoading = $state(false);

  function log(message: string) {
    output = [...output, `${new Date().toLocaleTimeString()}: ${message}`];
  }

  function clearLog() {
    output = [];
  }

  // =============================================================================
  // 📦 METHOD 1: Basic Language Change
  // =============================================================================

  async function basicLanguageChange(locale: string) {
    log(`🔄 Changing language to: ${locale}`);
    
    try {
      await i18n.setLocale(locale);
      log(`✅ Successfully changed to: ${i18n.locale}`);
      log(`📄 Sample text: ${i18n.t.updatingOverlay.title.getValue()}`);
    } catch (error) {
      log(`❌ Failed to change language: ${error}`);
    }
  }

  // =============================================================================
  // 📦 METHOD 2: Language Validation & Info
  // =============================================================================

  function checkLanguageSupport() {
    log('🔍 Checking language support...');
    
    // Get all available languages
    const available = i18n.getAvailableLocales();
    log(`📋 Available languages: ${available.join(', ')}`);
    
    // Check specific language support
    const testLocales = ['en', 'es', 'invalid', 'pt-BR'];
    testLocales.forEach(locale => {
      const supported = i18n.isLocaleSupported(locale);
      log(`${supported ? '✅' : '❌'} ${locale}: ${supported ? 'Supported' : 'Not supported'}`);
    });
    
    // Get detailed info for current language
    const currentInfo = i18n.getLocaleInfo(i18n.locale);
    log(`ℹ️  Current language info: ${JSON.stringify(currentInfo)}`);
  }

  // =============================================================================
  // 📦 METHOD 3: Batch Language Operations
  // =============================================================================

  async function demonstrateLanguageFeatures() {
    log('🚀 Starting comprehensive language demo...');
    
    // 1. Show current state
    log(`📍 Current locale: ${i18n.locale}`);
    log(`⏳ Is loading: ${i18n.isLoading}`);
    
    // 2. Try invalid language
    try {
      await i18n.setLocale('invalid');
    } catch (error) {
      log(`✅ Correctly rejected invalid locale: ${error.message.split('.')[0]}`);
    }
    
    // 3. Test multiple valid languages
    const testLanguages = ['es', 'fr', 'ja', 'en'];
    
    for (const lang of testLanguages) {
      log(`🔄 Testing ${lang}...`);
      await i18n.setLocale(lang);
      
      // Get some sample translations
      const title = i18n.t.updatingOverlay.title.getValue();
      const description = i18n.t.updatingOverlay.description.getValue();
      
      log(`  📝 Title: "${title}"`);
      log(`  📄 Description: "${description}"`);
      
      // Test template literal
      const streaming = i18n.t.general.streamingMessage.getValue({
        usingNetworksCount: 3,
        srtLatency: 100
      });
      log(`  🌐 Template: "${streaming}"`);
      
      // Wait a bit for demo purposes
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    log('🎉 Language demo completed!');
  }

  // =============================================================================
  // 📦 METHOD 4: Language Detection & Auto-setup
  // =============================================================================

  function detectAndSetBrowserLanguage() {
    log('🔍 Detecting browser language...');
    
    const browserLang = navigator.language;
    log(`🌐 Browser language: ${browserLang}`);
    
    // Extract language code (e.g., 'en' from 'en-US')
    const langCode = browserLang.split('-')[0];
    log(`🔤 Extracted language code: ${langCode}`);
    
    // Check if we support it
    if (i18n.isLocaleSupported(langCode)) {
      log(`✅ Browser language is supported!`);
      basicLanguageChange(langCode);
    } else {
      log(`❌ Browser language not supported. Available: ${i18n.getAvailableLocales().join(', ')}`);
    }
  }

  // =============================================================================
  // 📦 METHOD 5: Advanced Language Management
  // =============================================================================

  function showAdvancedLanguageInfo() {
    log('📊 Advanced Language Information:');
    
    // Show info for all available languages
    i18n.getAvailableLocales().forEach(locale => {
      const info = i18n.getLocaleInfo(locale);
      const isCurrent = locale === i18n.locale;
      log(`${isCurrent ? '👉' : '  '} ${info?.code}: ${info?.name} ${info?.loaded ? '(loaded)' : '(not loaded)'}`);
    });
  }

  // =============================================================================
  // 🎯 REACTIVE DEMONSTRATIONS
  // =============================================================================

  // Watch for language changes
  $effect(() => {
    log(`🔄 Language changed to: ${i18n.locale}`);
  });

  // Watch for loading state changes
  $effect(() => {
    if (i18n.isLoading) {
      log('⏳ Loading language data...');
    }
  });

  // =============================================================================
  // 🌍 QUICK LANGUAGE BUTTONS
  // =============================================================================

  const quickLanguages = [
    { code: 'en', name: 'English', emoji: '🇺🇸' },
    { code: 'es', name: 'Español', emoji: '🇪🇸' },
    { code: 'fr', name: 'Français', emoji: '🇫🇷' },
    { code: 'de', name: 'Deutsch', emoji: '🇩🇪' },
    { code: 'ja', name: '日本語', emoji: '🇯🇵' },
    { code: 'ar', name: 'العربية', emoji: '🇸🇦' }
  ];
</script>

<!-- =============================================================================
     UI DEMONSTRATION
     ============================================================================= -->

<div class="p-6 max-w-4xl mx-auto space-y-6">
  <div class="text-center">
    <h1 class="text-3xl font-bold mb-2">🌍 i18n Package Language API</h1>
    <p class="text-gray-600">Complete demonstration of language management in the @ceraui/i18n-typebox package</p>
  </div>

  <!-- Current Status -->
  <div class="bg-blue-50 p-4 rounded-lg">
    <h2 class="font-bold mb-2">📍 Current Status</h2>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div>
        <strong>Locale:</strong> {i18n.locale}
      </div>
      <div>
        <strong>Loading:</strong> {i18n.isLoading ? '⏳ Yes' : '✅ No'}
      </div>
      <div>
        <strong>Sample Text:</strong> {i18n.t.updatingOverlay.title.getValue()}
      </div>
      <div>
        <strong>Available:</strong> {i18n.getAvailableLocales().length} languages
      </div>
    </div>
  </div>

  <!-- Quick Language Switcher -->
  <div class="bg-gray-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🚀 Quick Language Switch</h2>
    <div class="flex flex-wrap gap-2">
      {#each quickLanguages as lang}
        <button
          onclick={() => basicLanguageChange(lang.code)}
          class="flex items-center gap-2 px-3 py-2 bg-white border rounded hover:bg-gray-100 transition-colors"
          class:bg-blue-100={lang.code === i18n.locale}
          class:border-blue-500={lang.code === i18n.locale}
          disabled={i18n.isLoading}
        >
          <span>{lang.emoji}</span>
          <span class="text-sm">{lang.name}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- API Methods -->
  <div class="bg-green-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🛠️ API Methods</h2>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
      <button
        onclick={checkLanguageSupport}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        📋 Check Support
      </button>
      
      <button
        onclick={demonstrateLanguageFeatures}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
        disabled={i18n.isLoading}
      >
        🚀 Full Demo
      </button>
      
      <button
        onclick={detectAndSetBrowserLanguage}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🔍 Auto Detect
      </button>
      
      <button
        onclick={showAdvancedLanguageInfo}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        📊 Advanced Info
      </button>
      
      <button
        onclick={clearLog}
        class="px-3 py-2 bg-red-100 border border-red-300 rounded hover:bg-red-200 text-sm"
      >
        🗑️ Clear Log
      </button>
    </div>
  </div>

  <!-- API Output Log -->
  <div class="bg-black text-green-400 p-4 rounded-lg font-mono text-sm">
    <div class="flex justify-between items-center mb-2">
      <h2 class="text-white font-bold">📟 API Output Log</h2>
      <span class="text-gray-400">Real-time package API calls</span>
    </div>
    
    <div class="max-h-96 overflow-y-auto space-y-1">
      {#each output as line}
        <div class="whitespace-pre-wrap">{line}</div>
      {/each}
      
      {#if output.length === 0}
        <div class="text-gray-500">Click any button above to see API calls in action...</div>
      {/if}
    </div>
  </div>

  <!-- API Reference -->
  <div class="bg-yellow-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">📚 Package API Reference</h2>
    <div class="grid md:grid-cols-2 gap-4 text-sm">
      <div>
        <h3 class="font-semibold mb-2">Core Methods:</h3>
        <ul class="space-y-1 text-gray-700">
          <li><code>await i18n.setLocale('es')</code> - Change language</li>
          <li><code>i18n.locale</code> - Get current language</li>
          <li><code>i18n.isLoading</code> - Check loading state</li>
          <li><code>i18n.useKey('key')</code> - Get translation</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2">Management Methods:</h3>
        <ul class="space-y-1 text-gray-700">
          <li><code>i18n.getAvailableLocales()</code> - List languages</li>
          <li><code>i18n.isLocaleSupported('es')</code> - Check support</li>
          <li><code>i18n.getLocaleInfo('es')</code> - Get details</li>
          <li><code>i18n.t.path.key.getValue()</code> - Type-safe access</li>
        </ul>
      </div>
    </div>
  </div>
</div>