<script lang="ts">
  import { i18n } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // LANGUAGE CONFIGURATION
  // =============================================================================

  const availableLanguages = [
    { code: 'en', name: 'English', emoji: '🇺🇸' },
    { code: 'es', name: 'Español', emoji: '🇪🇸' },
    { code: 'fr', name: 'Français', emoji: '🇫🇷' },
    { code: 'de', name: 'Deutsch', emoji: '🇩🇪' },
    { code: 'ar', name: 'العربية', emoji: '🇸🇦' },
    { code: 'hi', name: 'हिन्दी', emoji: '🇮🇳' },
    { code: 'ja', name: '日本語', emoji: '🇯🇵' },
    { code: 'ko', name: '한국어', emoji: '🇰🇷' },
    { code: 'pt-BR', name: 'Português (BR)', emoji: '🇧🇷' },
    { code: 'zh', name: '中文', emoji: '🇨🇳' }
  ];

  // =============================================================================
  // REACTIVE STATE
  // =============================================================================

  let isOpen = $state(false);
  let isLoading = $state(false);

  // Get current language info
  $: currentLang = availableLanguages.find(lang => lang.code === i18n.locale) || availableLanguages[0];

  // =============================================================================
  // LANGUAGE SWITCHING METHODS
  // =============================================================================

  /**
   * Method 1: Basic language switching
   */
  async function changeLanguage(langCode: string) {
    if (langCode === i18n.locale) return;
    
    isLoading = true;
    try {
      await i18n.setLocale(langCode);
      console.log(`✅ Language changed to: ${langCode}`);
      
      // Optional: Save to localStorage for persistence
      localStorage.setItem('preferred-language', langCode);
      
      // Optional: Send to backend for user preferences
      await updateUserLanguagePreference(langCode);
      
    } catch (error) {
      console.error('❌ Failed to change language:', error);
      // Handle error (show toast, revert, etc.)
    } finally {
      isLoading = false;
      isOpen = false;
    }
  }

  /**
   * Method 2: Advanced language switching with analytics
   */
  async function changeLanguageAdvanced(langCode: string, source: string = 'manual') {
    if (langCode === i18n.locale) return;
    
    isLoading = true;
    
    try {
      // 1. Get the language change event key for backend
      const eventKey = i18n.t.devtools.supportedLanguagesClick?.getKey() || 'language.changed';
      
      // 2. Change the language
      await i18n.setLocale(langCode);
      
      // 3. Log the change with structured data
      await fetch('/api/analytics/language-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventKey, // Backend gets: "devtools.supportedLanguagesClick"
          previousLanguage: currentLang.code,
          newLanguage: langCode,
          source, // 'manual', 'auto-detect', 'url-param', etc.
          timestamp: Date.now(),
          userAgent: navigator.userAgent
        })
      });
      
      console.log(`🌍 Language changed: ${currentLang.code} → ${langCode}`);
      
    } catch (error) {
      console.error('❌ Language change failed:', error);
    } finally {
      isLoading = false;
      isOpen = false;
    }
  }

  /**
   * Method 3: Auto-detect browser language
   */
  function detectBrowserLanguage() {
    const browserLang = navigator.language.toLowerCase();
    
    // Try exact match first
    let detectedLang = availableLanguages.find(lang => lang.code === browserLang)?.code;
    
    // Try language code without region (e.g., 'en' from 'en-US')
    if (!detectedLang) {
      const langCode = browserLang.split('-')[0];
      detectedLang = availableLanguages.find(lang => lang.code === langCode)?.code;
    }
    
    if (detectedLang && detectedLang !== i18n.locale) {
      changeLanguageAdvanced(detectedLang, 'auto-detect');
    }
  }

  /**
   * Method 4: Load from URL parameter or localStorage
   */
  function loadSavedLanguage() {
    // Check URL parameter first
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    
    if (urlLang && availableLanguages.some(lang => lang.code === urlLang)) {
      changeLanguageAdvanced(urlLang, 'url-param');
      return;
    }
    
    // Check localStorage
    const savedLang = localStorage.getItem('preferred-language');
    if (savedLang && availableLanguages.some(lang => lang.code === savedLang)) {
      changeLanguageAdvanced(savedLang, 'localStorage');
      return;
    }
    
    // Fallback to browser detection
    detectBrowserLanguage();
  }

  /**
   * Update user language preference on backend
   */
  async function updateUserLanguagePreference(langCode: string) {
    try {
      await fetch('/api/user/language-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: langCode,
          settingKey: i18n.t.locale?.selectLanguage?.getKey() || 'locale.selectLanguage'
        })
      });
    } catch (error) {
      // Silent fail - not critical
      console.warn('Failed to save language preference:', error);
    }
  }

  // =============================================================================
  // LIFECYCLE
  // =============================================================================

  // Load saved language on component mount
  $effect(() => {
    loadSavedLanguage();
  });

  // =============================================================================
  // KEYBOARD SHORTCUTS
  // =============================================================================

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      isOpen = false;
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- =============================================================================
     LANGUAGE SWITCHER UI
     ============================================================================= -->

<div class="relative">
  <!-- Current Language Button -->
  <button
    onclick={() => isOpen = !isOpen}
    class="flex items-center gap-2 px-3 py-2 bg-white border rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
    class:opacity-50={isLoading}
    disabled={isLoading}
  >
    <span class="text-lg">{currentLang.emoji}</span>
    <span class="font-medium">{currentLang.name}</span>
    
    {#if isLoading}
      <div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
    {:else}
      <svg class="w-4 h-4 transition-transform" class:rotate-180={isOpen} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
      </svg>
    {/if}
  </button>

  <!-- Language Dropdown -->
  {#if isOpen}
    <div class="absolute top-full left-0 mt-1 w-64 bg-white border rounded-lg shadow-lg z-50">
      <div class="p-2 border-b">
        <p class="text-sm font-medium text-gray-700">Choose Language</p>
      </div>
      
      <div class="max-h-80 overflow-y-auto">
        {#each availableLanguages as lang}
          <button
            onclick={() => changeLanguageAdvanced(lang.code)}
            class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
            class:bg-blue-50={lang.code === i18n.locale}
            class:text-blue-700={lang.code === i18n.locale}
          >
            <span class="text-lg">{lang.emoji}</span>
            <div class="flex-1">
              <div class="font-medium">{lang.name}</div>
              <div class="text-xs text-gray-500">{lang.code}</div>
            </div>
            
            {#if lang.code === i18n.locale}
              <svg class="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
              </svg>
            {/if}
          </button>
        {/each}
      </div>
      
      <div class="p-2 border-t bg-gray-50">
        <button
          onclick={detectBrowserLanguage}
          class="w-full text-sm text-blue-600 hover:text-blue-700 transition-colors"
        >
          🔍 Auto-detect from browser
        </button>
      </div>
    </div>
  {/if}
</div>

<!-- Click outside to close -->
{#if isOpen}
  <div 
    class="fixed inset-0 z-40" 
    onclick={() => isOpen = false}
  ></div>
{/if}