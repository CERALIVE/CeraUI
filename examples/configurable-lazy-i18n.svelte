<script lang="ts">
  import { i18n, createConfiguredI18n, setupI18n } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // 🎯 IMPROVED CONFIGURABLE & LAZY LOADING APPROACH
  // =============================================================================

  let output = $state<string[]>([]);
  let loadingStates = $state<Record<string, boolean>>({});

  function log(message: string) {
    output = [...output, `${new Date().toLocaleTimeString()}: ${message}`];
  }

  function clearLog() {
    output = [];
  }

  // =============================================================================
  // 📦 METHOD 1: Configure Default Instance (Recommended)
  // =============================================================================

  function configureDefaultInstance() {
    log('🛠️ Configuring default i18n instance...');
    
    // Define ONLY the languages your project supports
    const projectLanguages = ['en', 'es', 'fr', 'de'];
    i18n.configureSupportedLocales(projectLanguages);
    
    log(`✅ Configured supported locales: ${projectLanguages.join(', ')}`);
    log(`📋 Available locales: ${i18n.getAvailableLocales().join(', ')}`);
    
    // Test validation
    log(`✅ 'es' supported: ${i18n.isLocaleSupported('es')}`);
    log(`❌ 'xyz' supported: ${i18n.isLocaleSupported('xyz')}`);
  }

  // =============================================================================
  // 📦 METHOD 2: Create Pre-configured Instance
  // =============================================================================

  function demonstratePreConfigured() {
    log('🏗️ Creating pre-configured i18n instance...');
    
    // Create instance with only the languages you want
    const customI18n = createConfiguredI18n(['en', 'ja', 'ko'], 'ja');
    
    log(`🌍 Custom instance created with Japanese default`);
    log(`📋 Supported: ${customI18n.getAvailableLocales().join(', ')}`);
    log(`🎌 Current locale: ${customI18n.locale}`);
    
    // This instance only supports 3 languages, not all 10
    log(`✅ 'ko' supported: ${customI18n.isLocaleSupported('ko')}`);
    log(`❌ 'ar' supported: ${customI18n.isLocaleSupported('ar')}`);
  }

  // =============================================================================
  // 🚀 METHOD 3: Demonstrate True Lazy Loading
  // =============================================================================

  async function demonstrateLazyLoading() {
    log('⚡ Demonstrating lazy loading performance...');
    
    // Configure only 3 languages for performance
    i18n.configureSupportedLocales(['en', 'es', 'fr']);
    
    const languages = ['es', 'fr', 'en'];
    
    for (const lang of languages) {
      log(`🔄 Loading ${lang}... (only loads when requested)`);
      
      const startTime = performance.now();
      loadingStates[lang] = true;
      
      try {
        await i18n.setLocale(lang);
        const endTime = performance.now();
        
        log(`✅ ${lang} loaded in ${(endTime - startTime).toFixed(1)}ms`);
        log(`📄 Sample: "${i18n.t.updatingOverlay.title.getValue()}"`);
        
        // Subsequent access is instant (cached)
        const cacheStartTime = performance.now();
        await i18n.setLocale(lang);
        const cacheEndTime = performance.now();
        
        log(`⚡ Cache access: ${(cacheEndTime - cacheStartTime).toFixed(1)}ms (instant!)`);
        
      } catch (error) {
        log(`❌ Failed to load ${lang}: ${error}`);
      } finally {
        loadingStates[lang] = false;
      }
      
      // Small delay for demo
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    log('🎉 Lazy loading demo complete!');
  }

  // =============================================================================
  // 🎯 METHOD 4: Project-Specific Configuration
  // =============================================================================

  function demonstrateProjectConfig() {
    log('🏢 Project-specific language configuration...');
    
    // Example: E-commerce site only needs these languages
    const ecommerceLanguages = ['en', 'es', 'fr'];
    i18n.configureSupportedLocales(ecommerceLanguages);
    log(`🛒 E-commerce site configured: ${ecommerceLanguages.join(', ')}`);
    
    // Example: Gaming app needs different languages
    const gamingLanguages = ['en', 'ja', 'ko', 'zh'];
    const gamingI18n = createConfiguredI18n(gamingLanguages);
    log(`🎮 Gaming app configured: ${gamingLanguages.join(', ')}`);
    
    // Example: Corporate app needs European languages
    const corporateLanguages = ['en', 'de', 'fr', 'es'];
    const corporateI18n = createConfiguredI18n(corporateLanguages);
    log(`🏢 Corporate app configured: ${corporateLanguages.join(', ')}`);
    
    log('✨ Each instance only loads the languages it needs!');
  }

  // =============================================================================
  // ⚡ METHOD 5: Performance Comparison
  // =============================================================================

  async function performanceComparison() {
    log('📊 Performance comparison: Configured vs Unconfigured');
    
    // Test 1: Unconfigured (tries any language)
    const unconfiguredI18n = createConfiguredI18n([]); // No restrictions
    log('🔓 Testing unconfigured instance...');
    
    try {
      const start1 = performance.now();
      await unconfiguredI18n.setLocale('es');
      const end1 = performance.now();
      log(`✅ Unconfigured 'es': ${(end1 - start1).toFixed(1)}ms`);
    } catch (error) {
      log(`❌ Unconfigured failed: ${error}`);
    }
    
    // Test 2: Configured (validates before attempting)
    const configuredI18n = createConfiguredI18n(['en', 'es', 'fr']);
    log('🔒 Testing configured instance...');
    
    try {
      const start2 = performance.now();
      await configuredI18n.setLocale('es');
      const end2 = performance.now();
      log(`✅ Configured 'es': ${(end2 - start2).toFixed(1)}ms`);
    } catch (error) {
      log(`❌ Configured failed: ${error}`);
    }
    
    // Test 3: Invalid language (configured rejects early)
    try {
      const start3 = performance.now();
      await configuredI18n.setLocale('invalid');
      const end3 = performance.now();
      log(`? Invalid attempt: ${(end3 - start3).toFixed(1)}ms`);
    } catch (error) {
      log(`✅ Correctly rejected invalid language (no network request made)`);
    }
    
    log('📈 Configured instances are faster and safer!');
  }

  // =============================================================================
  // 🌍 CURRENT PROJECT LANGUAGES (from your locale files)
  // =============================================================================

  const actualProjectLanguages = ['en', 'es', 'fr', 'de', 'ar', 'hi', 'ja', 'ko', 'pt-BR', 'zh'];

  function setupProjectLanguages() {
    log('🎯 Setting up actual project languages...');
    i18n.configureSupportedLocales(actualProjectLanguages);
    log(`✅ Configured ${actualProjectLanguages.length} project languages`);
    log(`📋 Available: ${i18n.getAvailableLocales().join(', ')}`);
  }

  // =============================================================================
  // 🎮 QUICK LANGUAGE TEST
  // =============================================================================

  async function quickLanguageTest(lang: string) {
    if (!i18n.isLocaleSupported(lang)) {
      log(`❌ ${lang} is not in configured supported languages`);
      return;
    }
    
    loadingStates[lang] = true;
    try {
      const startTime = performance.now();
      await i18n.setLocale(lang);
      const endTime = performance.now();
      
      log(`✅ ${lang}: ${(endTime - startTime).toFixed(1)}ms - "${i18n.t.updatingOverlay.title.getValue()}"`);
    } catch (error) {
      log(`❌ ${lang} failed: ${error}`);
    } finally {
      loadingStates[lang] = false;
    }
  }

  // Auto-setup project languages on mount
  setupProjectLanguages();

  const quickTestLanguages = ['en', 'es', 'fr', 'ja', 'ar'];
</script>

<!-- =============================================================================
     IMPROVED UI DEMONSTRATION
     ============================================================================= -->

<div class="p-6 max-w-5xl mx-auto space-y-6">
  <div class="text-center">
    <h1 class="text-3xl font-bold mb-2">⚡ Configurable & Lazy Loading i18n</h1>
    <p class="text-gray-600">Performance-first approach with project-specific language configuration</p>
  </div>

  <!-- Current Status -->
  <div class="bg-blue-50 p-4 rounded-lg">
    <h2 class="font-bold mb-2">📍 Current Status</h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
      <div>
        <strong>Current:</strong> {i18n.locale}
      </div>
      <div>
        <strong>Loading:</strong> {i18n.isLoading ? '⏳ Yes' : '✅ No'}
      </div>
      <div>
        <strong>Configured:</strong> {i18n.getAvailableLocales().length} languages
      </div>
      <div>
        <strong>Sample:</strong> {i18n.t.updatingOverlay.title.getValue()}
      </div>
    </div>
  </div>

  <!-- Configuration Methods -->
  <div class="bg-green-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🛠️ Configuration Methods</h2>
    <div class="grid md:grid-cols-2 gap-4">
      <div class="space-y-2">
        <h3 class="font-semibold">🎯 Project Configuration</h3>
        <div class="flex flex-wrap gap-2">
          <button
            onclick={configureDefaultInstance}
            class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
          >
            📦 Configure Default
          </button>
          
          <button
            onclick={demonstratePreConfigured}
            class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
          >
            🏗️ Pre-configured
          </button>
          
          <button
            onclick={demonstrateProjectConfig}
            class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
          >
            🏢 Project Examples
          </button>
        </div>
      </div>
      
      <div class="space-y-2">
        <h3 class="font-semibold">⚡ Performance Testing</h3>
        <div class="flex flex-wrap gap-2">
          <button
            onclick={demonstrateLazyLoading}
            class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
            disabled={i18n.isLoading}
          >
            🚀 Lazy Loading
          </button>
          
          <button
            onclick={performanceComparison}
            class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
          >
            📊 Performance
          </button>
          
          <button
            onclick={clearLog}
            class="px-3 py-2 bg-red-100 border border-red-300 rounded hover:bg-red-200 text-sm"
          >
            🗑️ Clear
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Quick Language Tests -->
  <div class="bg-yellow-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🎮 Quick Language Tests (Lazy Loading)</h2>
    <div class="flex flex-wrap gap-2">
      {#each quickTestLanguages as lang}
        <button
          onclick={() => quickLanguageTest(lang)}
          class="flex items-center gap-2 px-3 py-2 bg-white border rounded hover:bg-gray-100 transition-colors"
          class:bg-blue-100={lang === i18n.locale}
          class:border-blue-500={lang === i18n.locale}
          disabled={loadingStates[lang]}
        >
          <span class="text-sm font-medium">{lang.toUpperCase()}</span>
          {#if loadingStates[lang]}
            <div class="w-3 h-3 border border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          {/if}
        </button>
      {/each}
    </div>
    <p class="text-xs text-gray-600 mt-2">
      💡 Each language loads only when clicked (lazy) and is cached for subsequent access
    </p>
  </div>

  <!-- Live Performance Log -->
  <div class="bg-black text-green-400 p-4 rounded-lg font-mono text-sm">
    <div class="flex justify-between items-center mb-2">
      <h2 class="text-white font-bold">📟 Performance & Configuration Log</h2>
      <span class="text-gray-400">Real-time lazy loading metrics</span>
    </div>
    
    <div class="max-h-96 overflow-y-auto space-y-1">
      {#each output as line}
        <div class="whitespace-pre-wrap">{line}</div>
      {/each}
      
      {#if output.length === 0}
        <div class="text-gray-500">Configure languages above to see lazy loading in action...</div>
      {/if}
    </div>
  </div>

  <!-- Benefits Summary -->
  <div class="bg-purple-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">✨ Benefits of New Approach</h2>
    <div class="grid md:grid-cols-2 gap-4 text-sm">
      <div>
        <h3 class="font-semibold mb-2 text-purple-700">🚀 Performance</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• Only loads languages you define</li>
          <li>• Lazy loading reduces initial bundle size</li>
          <li>• Cached after first load (instant subsequent access)</li>
          <li>• No wasted network requests for unused languages</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2 text-purple-700">🎯 Configuration</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• Project-specific language definitions</li>
          <li>• No hard-coded languages in package</li>
          <li>• Validation prevents loading invalid locales</li>
          <li>• Multiple configuration patterns supported</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- API Reference -->
  <div class="bg-gray-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">📚 Improved API Reference</h2>
    <div class="grid md:grid-cols-3 gap-4 text-sm">
      <div>
        <h3 class="font-semibold mb-2">🛠️ Configuration</h3>
        <ul class="space-y-1 text-gray-700 font-mono">
          <li>i18n.configureSupportedLocales(['en', 'es'])</li>
          <li>createConfiguredI18n(['en', 'fr'])</li>
          <li>setupI18n('en', {supportedLocales: [...]})</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2">⚡ Usage</h3>
        <ul class="space-y-1 text-gray-700 font-mono">
          <li>await i18n.setLocale('es') // Lazy load</li>
          <li>i18n.getAvailableLocales() // Your langs</li>
          <li>i18n.isLocaleSupported('fr') // Validate</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2">📊 Benefits</h3>
        <ul class="space-y-1 text-gray-700">
          <li>🚀 Better performance</li>
          <li>🎯 Project-specific</li>
          <li>⚡ Lazy loading</li>
          <li>✅ Type-safe</li>
        </ul>
      </div>
    </div>
  </div>
</div>