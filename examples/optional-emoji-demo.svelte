<script lang="ts">
  import { i18n, createConfiguredI18n } from '$lib/stores/i18n.svelte.ts';
  import type { LocaleInfo } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // 🎯 OPTIONAL EMOJI/ICON DEMONSTRATION
  // =============================================================================

  let output = $state<string[]>([]);

  function log(message: string) {
    output = [...output, `${new Date().toLocaleTimeString()}: ${message}`];
  }

  function clearLog() {
    output = [];
  }

  // =============================================================================
  // ✅ FLEXIBLE CONFIGURATION OPTIONS
  // =============================================================================

  function demonstrateFlexibleConfig() {
    log('🎨 Testing flexible language configuration options...');
    
    // Option 1: Minimal config (just code + name)
    const minimalConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },                    // No emoji, no nativeName
      { code: 'es', name: 'Spanish' },                    // No emoji, no nativeName
      { code: 'fr', name: 'French' }                      // No emoji, no nativeName
    ];
    
    log('📦 Option 1: Minimal config (no emojis)');
    i18n.configureSupportedLocales(minimalConfig);
    const minimal = i18n.getAvailableLocalesWithInfo();
    minimal.forEach(lang => {
      log(`   ${lang.emoji || '🌐'} ${lang.code}: ${lang.name}`);
    });
    
    // Option 2: Names only, no emojis
    const namesOnlyConfig: LocaleInfo[] = [
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'de', name: 'German', nativeName: 'Deutsch' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語' }
    ];
    
    log('📦 Option 2: Names + native names (no emojis)');
    i18n.configureSupportedLocales(namesOnlyConfig);
    const namesOnly = i18n.getAvailableLocalesWithInfo();
    namesOnly.forEach(lang => {
      log(`   ${lang.emoji || '🌐'} ${lang.code}: ${lang.name} (${lang.nativeName || 'N/A'})`);
    });
    
    // Option 3: Mixed config (some with emojis, some without)
    const mixedConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },                                    // No emoji
      { code: 'es', name: 'Spanish', emoji: '🇪🇸' },                      // With emoji
      { code: 'fr', name: 'French', nativeName: 'Français' },             // No emoji
      { code: 'de', name: 'German', nativeName: 'Deutsch', emoji: '🇩🇪' }, // Both
      { code: 'ja', name: 'Japanese', nativeName: '日本語' }              // No emoji
    ];
    
    log('📦 Option 3: Mixed config (some emojis, some not)');
    i18n.configureSupportedLocales(mixedConfig);
    const mixed = i18n.getAvailableLocalesWithInfo();
    mixed.forEach(lang => {
      const emoji = lang.emoji || '🌐'; // Fallback emoji
      const native = lang.nativeName || 'N/A';
      log(`   ${emoji} ${lang.code}: ${lang.name} (${native})`);
    });
  }

  // =============================================================================
  // 🏢 REAL-WORLD SCENARIOS
  // =============================================================================

  function demonstrateRealWorldScenarios() {
    log('🏢 Real-world scenarios without emojis...');
    
    // Scenario 1: Corporate app (professional, no emojis)
    const corporateConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },
      { code: 'de', name: 'German' },
      { code: 'fr', name: 'French' },
      { code: 'es', name: 'Spanish' }
    ];
    
    const corporateI18n = createConfiguredI18n(corporateConfig);
    log('🏢 Corporate app (no emojis):');
    corporateI18n.getAvailableLocalesWithInfo().forEach(lang => {
      log(`   • ${lang.name} (${lang.code})`);
    });
    
    // Scenario 2: API/Backend system (codes + names only)
    const apiConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },
      { code: 'zh', name: 'Chinese' },
      { code: 'ja', name: 'Japanese' },
      { code: 'ko', name: 'Korean' }
    ];
    
    const apiI18n = createConfiguredI18n(apiConfig);
    log('🔧 API/Backend system (structured, no emojis):');
    apiI18n.getAvailableLocalesWithInfo().forEach(lang => {
      log(`   • ${lang.code.toUpperCase()}: ${lang.name}`);
    });
    
    // Scenario 3: Mixed approach (some teams want emojis, some don't)
    const mixedTeamConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },                                    // Team A: No emojis
      { code: 'es', name: 'Spanish', emoji: '🇪🇸' },                      // Team B: With emojis
      { code: 'fr', name: 'French' },                                     // Team A: No emojis
      { code: 'de', name: 'German', emoji: '🇩🇪' }                        // Team B: With emojis
    ];
    
    const mixedTeamI18n = createConfiguredI18n(mixedTeamConfig);
    log('👥 Mixed team preferences:');
    mixedTeamI18n.getAvailableLocalesWithInfo().forEach(lang => {
      log(`   ${lang.emoji || '•'} ${lang.name} (${lang.code})`);
    });
  }

  // =============================================================================
  // 🎯 FALLBACK STRATEGIES
  // =============================================================================

  function demonstrateFallbackStrategies() {
    log('🛡️ Testing fallback strategies for missing emojis...');
    
    // Configure languages without emojis
    const noEmojiConfig: LocaleInfo[] = [
      { code: 'en', name: 'English' },
      { code: 'es', name: 'Spanish' },
      { code: 'fr', name: 'French' }
    ];
    
    i18n.configureSupportedLocales(noEmojiConfig);
    
    // Different fallback strategies
    const langs = i18n.getAvailableLocalesWithInfo();
    
    log('🛡️ Fallback strategy examples:');
    langs.forEach(lang => {
      // Strategy 1: Generic globe emoji
      const fallback1 = lang.emoji || '🌐';
      log(`   Strategy 1 (🌐): ${fallback1} ${lang.name}`);
      
      // Strategy 2: First letter of language
      const fallback2 = lang.emoji || lang.code.charAt(0).toUpperCase();
      log(`   Strategy 2 (Letter): ${fallback2} ${lang.name}`);
      
      // Strategy 3: Bullet point
      const fallback3 = lang.emoji || '•';
      log(`   Strategy 3 (Bullet): ${fallback3} ${lang.name}`);
      
      // Strategy 4: No visual indicator
      const fallback4 = lang.emoji ? `${lang.emoji} ${lang.name}` : lang.name;
      log(`   Strategy 4 (None): ${fallback4}`);
    });
  }

  // =============================================================================
  // 🧪 VALIDATION TESTS
  // =============================================================================

  function testValidConfigurations() {
    log('🧪 Testing valid configuration variations...');
    
    // Test 1: Absolutely minimal
    try {
      const minimal: LocaleInfo[] = [{ code: 'en', name: 'English' }];
      const testI18n = createConfiguredI18n(minimal);
      log('✅ Test 1 passed: Minimal config (code + name only)');
    } catch (error) {
      log(`❌ Test 1 failed: ${error}`);
    }
    
    // Test 2: Only required fields for multiple languages
    try {
      const multiMinimal: LocaleInfo[] = [
        { code: 'en', name: 'English' },
        { code: 'es', name: 'Spanish' },
        { code: 'fr', name: 'French' },
        { code: 'de', name: 'German' },
        { code: 'ja', name: 'Japanese' }
      ];
      const testI18n2 = createConfiguredI18n(multiMinimal);
      log('✅ Test 2 passed: Multiple languages (no optional fields)');
    } catch (error) {
      log(`❌ Test 2 failed: ${error}`);
    }
    
    // Test 3: Mix of with and without optional fields
    try {
      const mixed: LocaleInfo[] = [
        { code: 'en', name: 'English' },
        { code: 'es', name: 'Spanish', emoji: '🇪🇸' },
        { code: 'fr', name: 'French', nativeName: 'Français' },
        { code: 'de', name: 'German', nativeName: 'Deutsch', emoji: '🇩🇪' }
      ];
      const testI18n3 = createConfiguredI18n(mixed);
      log('✅ Test 3 passed: Mixed optional fields');
    } catch (error) {
      log(`❌ Test 3 failed: ${error}`);
    }
    
    log('🎉 All configuration tests passed!');
  }

  // =============================================================================
  // 🎮 INTERACTIVE TESTS
  // =============================================================================

  async function testLanguageWithoutEmoji(code: string) {
    const info = i18n.getLocaleInfo(code);
    if (!info) {
      log(`❌ ${code} not configured`);
      return;
    }
    
    try {
      await i18n.setLocale(code);
      const emoji = info.emoji || '🌐'; // Fallback
      log(`✅ ${emoji} ${info.name}: "${i18n.t.updatingOverlay.title.getValue()}"`);
    } catch (error) {
      log(`❌ ${info.name} failed: ${error}`);
    }
  }

  // Auto-run demonstration
  demonstrateFlexibleConfig();
</script>

<!-- =============================================================================
     OPTIONAL EMOJI UI DEMONSTRATION
     ============================================================================= -->

<div class="p-6 max-w-5xl mx-auto space-y-6">
  <div class="text-center">
    <h1 class="text-3xl font-bold mb-2">🎨 Optional Emoji/Icon Configuration</h1>
    <p class="text-gray-600">Demonstrating flexible language configuration without requiring emojis</p>
  </div>

  <!-- Interface Definition -->
  <div class="bg-blue-50 border border-blue-200 p-4 rounded-lg">
    <h2 class="font-bold text-blue-800 mb-3">✅ Interface Definition</h2>
    <div class="bg-white p-3 rounded border font-mono text-sm">
      <div class="text-gray-600">// Both nativeName and emoji are optional!</div>
      <div class="text-blue-600">export interface</div> <div class="text-green-600">LocaleInfo</div> {
      <div class="ml-4">
        <div><span class="text-blue-600">code</span>: <span class="text-orange-600">string</span>;        <span class="text-gray-500">// ✅ Required</span></div>
        <div><span class="text-blue-600">name</span>: <span class="text-orange-600">string</span>;        <span class="text-gray-500">// ✅ Required</span></div>
        <div><span class="text-blue-600">nativeName</span>?: <span class="text-orange-600">string</span>; <span class="text-gray-500">// ⚡ Optional</span></div>
        <div><span class="text-blue-600">emoji</span>?: <span class="text-orange-600">string</span>;      <span class="text-gray-500">// ⚡ Optional (your question!)</span></div>
      </div>
      }
    </div>
  </div>

  <!-- Configuration Examples -->
  <div class="bg-green-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🛠️ Configuration Examples</h2>
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
      <button
        onclick={demonstrateFlexibleConfig}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🎨 Flexible Config
      </button>
      
      <button
        onclick={demonstrateRealWorldScenarios}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🏢 Real-world Cases
      </button>
      
      <button
        onclick={demonstrateFallbackStrategies}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🛡️ Fallback Strategies
      </button>
      
      <button
        onclick={testValidConfigurations}
        class="px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm"
      >
        🧪 Validation Tests
      </button>
      
      <button
        onclick={clearLog}
        class="px-3 py-2 bg-red-100 border border-red-300 rounded hover:bg-red-200 text-sm"
      >
        🗑️ Clear
      </button>
    </div>
  </div>

  <!-- Live Examples -->
  <div class="bg-yellow-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">🎮 Current Languages (with flexible emoji handling)</h2>
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
      {#each i18n.getAvailableLocalesWithInfo() as lang}
        <button
          onclick={() => testLanguageWithoutEmoji(lang.code)}
          class="flex items-center gap-2 px-3 py-2 bg-white border rounded hover:bg-gray-100 text-sm transition-colors"
          class:bg-blue-100={lang.code === i18n.locale}
          class:border-blue-500={lang.code === i18n.locale}
        >
          <!-- Fallback emoji handling -->
          <span class="text-lg">{lang.emoji || '🌐'}</span>
          <div class="text-left">
            <div class="font-medium">{lang.name}</div>
            <div class="text-xs text-gray-500">{lang.nativeName || lang.code}</div>
          </div>
        </button>
      {/each}
    </div>
    <p class="text-xs text-gray-600 mt-2">
      💡 Notice: Languages without emojis get a fallback 🌐 globe icon
    </p>
  </div>

  <!-- API Output -->
  <div class="bg-black text-green-400 p-4 rounded-lg font-mono text-sm">
    <div class="flex justify-between items-center mb-2">
      <h2 class="text-white font-bold">📟 Optional Emoji Configuration Tests</h2>
      <span class="text-gray-400">Flexible language setup</span>
    </div>
    
    <div class="max-h-96 overflow-y-auto space-y-1">
      {#each output as line}
        <div class="whitespace-pre-wrap">{line}</div>
      {/each}
      
      {#if output.length === 0}
        <div class="text-gray-500">Testing flexible configuration options...</div>
      {/if}
    </div>
  </div>

  <!-- Benefits Summary -->
  <div class="bg-purple-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">✨ Benefits of Optional Emojis</h2>
    <div class="grid md:grid-cols-2 gap-4 text-sm">
      <div>
        <h3 class="font-semibold mb-2 text-purple-700">🎯 Flexibility</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• Corporate apps: No emojis needed</li>
          <li>• API systems: Code + name only</li>
          <li>• Consumer apps: Full emoji support</li>
          <li>• Mixed teams: Some with, some without</li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2 text-purple-700">🛡️ Fallback Options</h3>
        <ul class="space-y-1 text-gray-700">
          <li>• Default emoji: 🌐 globe icon</li>
          <li>• Letter codes: E, S, F, etc.</li>
          <li>• Bullet points: • Simple indicators</li>
          <li>• No indicator: Just language names</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Quick Reference -->
  <div class="bg-gray-50 p-4 rounded-lg">
    <h2 class="font-bold mb-3">📚 Quick Configuration Reference</h2>
    <div class="grid md:grid-cols-2 gap-4 text-sm font-mono">
      <div>
        <h3 class="font-semibold mb-2 text-gray-700">✅ Valid Configurations</h3>
        <div class="space-y-1 text-green-700">
          <div>{ code: 'en', name: 'English' }</div>
          <div>{ code: 'es', name: 'Spanish', emoji: '🇪🇸' }</div>
          <div>{ code: 'fr', name: 'French', nativeName: 'Français' }</div>
          <div>{ code: 'de', name: 'German', nativeName: 'Deutsch', emoji: '🇩🇪' }</div>
        </div>
      </div>
      
      <div>
        <h3 class="font-semibold mb-2 text-gray-700">🛡️ Fallback Handling</h3>
        <div class="space-y-1 text-blue-700">
          <div>lang.emoji || '🌐'  // Globe fallback</div>
          <div>lang.emoji || '•'   // Bullet fallback</div>
          <div>lang.emoji || lang.code[0]  // Letter fallback</div>
          <div>lang.emoji ? emoji + name : name  // No fallback</div>
        </div>
      </div>
    </div>
  </div>
</div>