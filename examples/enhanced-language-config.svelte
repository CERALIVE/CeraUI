<script lang="ts">
  import { i18n, createConfiguredI18n } from '$lib/stores/i18n.svelte.ts';
  import type { LocaleInfo } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // 🎯 ENHANCED LANGUAGE MANAGEMENT ANSWERS
  // =============================================================================

  let output = $state<string[]>([]);

  function log(message: string) {
    output = [...output, `${new Date().toLocaleTimeString()}: ${message}`];
  }

  function clearLog() {
    output = [];
  }

  // =============================================================================
  // ✅ ANSWER 1: Language Names & Metadata
  // =============================================================================

  function demonstrateLanguageNames() {
    log('📝 Testing language names and metadata...');
    
    // Configure with FULL language info (names, native names, emojis)
    const languagesWithInfo: LocaleInfo[] = [
      { code: 'en', name: 'English', nativeName: 'English', emoji: '🇺🇸' },
      { code: 'es', name: 'Spanish', nativeName: 'Español', emoji: '🇪🇸' },
      { code: 'fr', name: 'French', nativeName: 'Français', emoji: '🇫🇷' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語', emoji: '🇯🇵' },
      { code: 'ar', name: 'Arabic', nativeName: 'العربية', emoji: '🇸🇦' }
    ];
    
    i18n.configureSupportedLocales(languagesWithInfo);
    
    // ✅ NEW: Get just codes (simple)
    const codes = i18n.getAvailableLocales();
    log(`📋 Codes only: ${codes.join(', ')}`);
    
    // ✅ NEW: Get full info (names, native names, emojis)
    const fullInfo = i18n.getAvailableLocalesWithInfo();
    log('📋 Full language info:');
    fullInfo.forEach(lang => {
      log(`   ${lang.emoji} ${lang.code}: ${lang.name} (${lang.nativeName})`);
    });
    
    // ✅ NEW: Get specific language info
    const spanishInfo = i18n.getLocaleInfo('es');
    if (spanishInfo) {
      log(`🔍 Spanish info: ${spanishInfo.emoji} ${spanishInfo.name} (${spanishInfo.nativeName})`);
    }
  }

  // =============================================================================
  // ✅ ANSWER 2: Configurable Locale Paths
  // =============================================================================

  function demonstrateCustomPaths() {
    log('📁 Testing configurable locale paths...');
    
    // ✅ NEW: Configure custom locale directory
    i18n.setLocaleBasePath('/assets/i18n'); // Instead of default /src/locale
    log('✅ Set custom locale path: /assets/i18n');
    
    // Create instance with custom path from the start
    const customI18n = createConfiguredI18n(
      ['en', 'es', 'fr'], 
      'en',
      '/custom/translations' // Custom path
    );
    
    log('✅ Created instance with custom path: /custom/translations');
    log(`📋 Custom instance languages: ${customI18n.getAvailableLocales().join(', ')}`);
    
    // Reset to default for demo
    i18n.setLocaleBasePath('/src/locale');
    log('🔄 Reset to default path: /src/locale');
  }

  // =============================================================================
  // 🎯 ANSWER 3: Multiple Configuration Methods
  // =============================================================================

  function demonstrateConfigurationMethods() {
    log('🛠️ Testing different configuration methods...');
    
    // Method 1: Simple strings (auto-generates basic info)
    log('📦 Method 1: Simple string configuration');
    i18n.configureSupportedLocales(['en', 'es', 'fr']);
    const simpleInfo = i18n.getAvailableLocalesWithInfo();
    simpleInfo.forEach(lang => {
      log(`   ${lang.code}: ${lang.name} (auto-generated)`);
    });
    
    // Method 2: Full LocaleInfo objects
    log('📦 Method 2: Full LocaleInfo configuration');
    const fullConfig: LocaleInfo[] = [
      { code: 'en', name: 'English', nativeName: 'English', emoji: '🇺🇸' },
      { code: 'de', name: 'German', nativeName: 'Deutsch', emoji: '🇩🇪' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語', emoji: '🇯🇵' }
    ];
    i18n.configureSupportedLocales(fullConfig);
    const detailedInfo = i18n.getAvailableLocalesWithInfo();
    detailedInfo.forEach(lang => {
      log(`   ${lang.emoji} ${lang.code}: ${lang.name} (${lang.nativeName})`);
    });
    
    // Method 3: Mixed configuration (some detailed, some simple)
    log('📦 Method 3: Mixed configuration');
    const mixedConfig = [
      'en', // Simple string
      { code: 'es', name: 'Spanish', nativeName: 'Español', emoji: '🇪🇸' }, // Full info
      'fr' // Simple string
    ];
    i18n.configureSupportedLocales(mixedConfig);
    const mixedInfo = i18n.getAvailableLocalesWithInfo();
    mixedInfo.forEach(lang => {
      log(`   ${lang.emoji || '🌐'} ${lang.code}: ${lang.name}`);
    });
  }

  // =============================================================================
  // 🚀 ANSWER 4: Project-Specific Examples
  // =============================================================================

  function demonstrateProjectExamples() {
    log('🏢 Project-specific configuration examples...');
    
    // Example 1: E-commerce site (Americas + Europe)
    const ecommerceConfig: LocaleInfo[] = [
      { code: 'en', name: 'English', nativeName: 'English', emoji: '🇺🇸' },
      { code: 'es', name: 'Spanish', nativeName: 'Español', emoji: '🇪🇸' },
      { code: 'fr', name: 'French', nativeName: 'Français', emoji: '🇫🇷' },
      { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (BR)', emoji: '🇧🇷' }
    ];
    
    const ecommerceI18n = createConfiguredI18n(ecommerceConfig, 'en', '/assets/ecommerce-locales');
    log(`🛒 E-commerce: ${ecommerceI18n.getAvailableLocales().join(', ')}`);
    
    // Example 2: Gaming app (Asia-Pacific focus)
    const gamingConfig: LocaleInfo[] = [
      { code: 'en', name: 'English', emoji: '🇺🇸' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語', emoji: '🇯🇵' },
      { code: 'ko', name: 'Korean', nativeName: '한국어', emoji: '🇰🇷' },
      { code: 'zh', name: 'Chinese', nativeName: '中文', emoji: '🇨🇳' }
    ];
    
    const gamingI18n = createConfiguredI18n(gamingConfig, 'en', '/assets/gaming-locales');
    log(`🎮 Gaming: ${gamingI18n.getAvailableLocales().join(', ')}`);
    
    // Example 3: Corporate app (minimal setup)
    const corporateI18n = createConfiguredI18n(['en', 'de', 'fr'], 'en', '/corporate/translations');
    log(`🏢 Corporate: ${corporateI18n.getAvailableLocales().join(', ')}`);
  }

  // =============================================================================
  // 📊 ANSWER 5: Comparison with Old vs New
  // =============================================================================

  function compareOldVsNew() {
    log('📊 Comparing old vs new approach...');
    
    log('❌ OLD APPROACH (hard-coded):');
    log('   - Package dictated: [en, es, fr, de, ar, hi, ja, ko, pt-BR, zh]');
    log('   - Only codes returned: ["en", "es", "fr"]');
    log('   - Fixed path: /src/locale');
    log('   - No language names');
    
    log('✅ NEW APPROACH (configurable):');
    
    // Configure exactly what YOUR project needs
    const projectConfig: LocaleInfo[] = [
      { code: 'en', name: 'English', emoji: '🇺🇸' },
      { code: 'es', name: 'Spanish', nativeName: 'Español', emoji: '🇪🇸' },
      { code: 'fr', name: 'French', nativeName: 'Français', emoji: '🇫🇷' }
    ];
    
    i18n.configureSupportedLocales(projectConfig);
    i18n.setLocaleBasePath('/custom/locale/path');
    
    log(`   ✅ YOU define languages: ${i18n.getAvailableLocales().join(', ')}`);
    log(`   ✅ Full language info available`);
    log(`   ✅ Custom locale path: /custom/locale/path`);
    log(`   ✅ Language names: ${i18n.getAvailableLocalesWithInfo().map(l => l.name).join(', ')}`);
    
    // Reset for demo
    i18n.setLocaleBasePath('/src/locale');
  }

  // =============================================================================
  // 🎯 YOUR PROJECT SETUP
  // =============================================================================

  function setupYourProject() {
    log('🎯 Setting up YOUR specific project...');
    
    // Based on your actual locale files
    const yourProjectLanguages: LocaleInfo[] = [
      { code: 'en', name: 'English', nativeName: 'English', emoji: '🇺🇸' },
      { code: 'es', name: 'Spanish', nativeName: 'Español', emoji: '🇪🇸' },
      { code: 'fr', name: 'French', nativeName: 'Français', emoji: '🇫🇷' },
      { code: 'de', name: 'German', nativeName: 'Deutsch', emoji: '🇩🇪' },
      { code: 'ar', name: 'Arabic', nativeName: 'العربية', emoji: '🇸🇦' },
      { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', emoji: '🇮🇳' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語', emoji: '🇯🇵' },
      { code: 'ko', name: 'Korean', nativeName: '한국어', emoji: '🇰🇷' },
      { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (BR)', emoji: '🇧🇷' },
      { code: 'zh', name: 'Chinese', nativeName: '中文', emoji: '🇨🇳' }
    ];
    
    i18n.configureSupportedLocales(yourProjectLanguages);
    log(`✅ Configured ${yourProjectLanguages.length} languages for your project`);
    
    // Show the enhanced info
    log('📋 Your project languages with full info:');
    const yourInfo = i18n.getAvailableLocalesWithInfo();
    yourInfo.forEach(lang => {
      log(`   ${lang.emoji} ${lang.code}: ${lang.name} (${lang.nativeName})`);
    });
  }

  // =============================================================================
  // 🎮 QUICK TESTS
  // =============================================================================

  async function testLanguageWithInfo(code: string) {
    const info = i18n.getLocaleInfo(code);
    if (!info) {
      log(`❌ ${code} not configured`);
      return;
    }
    
    try {
      await i18n.setLocale(code);
      log(`✅ ${info.emoji} ${info.name}: "${i18n.t.updatingOverlay.title.getValue()}"`);
    } catch (error) {
      log(`❌ ${info.name} failed: ${error}`);
    }
  }

  // Auto setup
  setupYourProject();
</script>

<!-- =============================================================================
     ENHANCED UI DEMONSTRATION
     ============================================================================= -->

<div class="p-6 max-w-5xl mx-auto space-y-6">
  <div class="text-center">
    <h1 class="text-3xl font-bold mb-2">✨ Enhanced Language Management</h1>
    <p class="text-gray-600">Answers to: Language names + Configurable paths</p>
  </div>

  <!-- Key Questions Answered -->
  <div class="bg-green-50 border border-green-200 p-4 rounded-lg">
    <h2 class="font-bold text-green-800 mb-3">✅ Questions Answered</h2>
    <div class="grid md:grid-cols-2 gap-4 text-sm">
      <div>
        <h3 class="font-semibold text-green-700">❓ Language Names</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• <code>getAvailableLocales()</code> → codes only</li>
          <li>• <code>getAvailableLocalesWithInfo()</code> → full info</li>
          <li>• <code>getLocaleInfo('es')</code> → specific language</li>
          <li>• Configure with names, native names, emojis</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold text-green-700">❓ Locale File Paths</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• <code>setLocaleBasePath('/custom/path')</code></li>
          <li>• <code>createConfiguredI18n(langs, 'en', '/path')</code></li>
          <li>• Default: <code>/src/locale</code></li>
          <li>• Fully configurable per project</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Current Enhanced Status -->
  <div class="bg-blue-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">📍 Enhanced Status</h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
      <div>
        <strong>Current:</strong> {i18n.locale}
        {#if i18n.getLocaleInfo(i18n.locale)}
          <br><span class="text-xs text-gray-600">{i18n.getLocaleInfo(i18n.locale)?.emoji} {i18n.getLocaleInfo(i18n.locale)?.name}</span>
        {/if}
      </div>
      <div>
        <strong>Configured:</strong> {i18n.getAvailableLocales().length} languages
      </div>
      <div>
        <strong>With Names:</strong> ✅ Full info available
      </div>
      <div>
        <strong>Path:</strong> Configurable
      </div>
    </div>
  </div>

  <!-- Feature Demonstrations -->
  <div class="bg-purple-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🧪 Enhanced Features Demo</h2>
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
      <button
        onclick={demonstrateLanguageNames}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        📝 Language Names
      </button>
      
      <button
        onclick={demonstrateCustomPaths}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        📁 Custom Paths
      </button>
      
      <button
        onclick={demonstrateConfigurationMethods}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🛠️ Config Methods
      </button>
      
      <button
        onclick={demonstrateProjectExamples}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🏢 Project Examples
      </button>
      
      <button
        onclick={compareOldVsNew}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        📊 Old vs New
      </button>
      
      <button
        onclick={clearLog}
        class="px-3 py-2 bg-red-100 border border-red-300 rounded hover:bg-red-200 text-sm"
      >
        🗑️ Clear
      </button>
    </div>
  </div>

  <!-- Language Info Display -->
  <div class="bg-yellow-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🌍 Your Project Languages (with full info)</h2>
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
      {#each i18n.getAvailableLocalesWithInfo() as lang}
        <button
          onclick={() => testLanguageWithInfo(lang.code)}
          class="flex items-center gap-2 px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm transition-colors"
          class:bg-blue-100={lang.code === i18n.locale}
          class:border-blue-500={lang.code === i18n.locale}
        >
          <span class="text-lg">{lang.emoji}</span>
          <div class="text-left">
            <div class="font-medium">{lang.name}</div>
            <div class="text-xs text-gray-500">{lang.nativeName || lang.code}</div>
          </div>
        </button>
      {/each}
    </div>
  </div>

  <!-- Enhanced API Log -->
  <div class="bg-black text-green-400 p-4 rounded-lg font-mono text-sm">
    <div class="flex justify-between items-center mb-2">
      <h2 class="text-white font-bold">📟 Enhanced API Demonstrations</h2>
      <span class="text-gray-400">Language names + Custom paths</span>
    </div>
    
    <div class="max-h-96 overflow-y-auto space-y-1">
      {#each output as line}
        <div class="whitespace-pre-wrap">{line}</div>
      {/each}
      
      {#if output.length === 0}
        <div class="text-gray-500">Click buttons above to see enhanced language features...</div>
      {/if}
    </div>
  </div>

  <!-- Enhanced API Reference -->
  <div class="bg-gray-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">📚 Enhanced API Reference</h2>
    <div class="grid md:grid-cols-2 gap-6 text-sm">
      <div>
        <h3 class="font-semibold mb-2 text-blue-700">🆕 Language Info Methods</h3>
        <ul class="space-y-1 text-gray-700 font-mono">
          <li>i18n.getAvailableLocales() // ['en', 'es']</li>
          <li>i18n.getAvailableLocalesWithInfo() // Full info</li>
          <li>i18n.getLocaleInfo('es') // Single language</li>
          <li>lang.name, lang.nativeName, lang.emoji</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2 text-blue-700">🆕 Path Configuration</h3>
        <ul class="space-y-1 text-gray-700 font-mono">
          <li>i18n.setLocaleBasePath('/custom/path')</li>
          <li>createConfiguredI18n(langs, 'en', '/path')</li>
          <li>setupI18n('en', {localeBasePath: '/path'})</li>
          <li>Default: '/src/locale'</li>
        </ul>
      </div>
    </div>
  </div>
</div>