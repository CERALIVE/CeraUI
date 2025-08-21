/**
 * Svelte 5 Adapter for TypeBox i18n
 * 
 * Generates Svelte 5 runes-based store with dual access patterns:
 * 1. Type-safe references: i18n.t.auth.validation.passwordMinLength.getKey() 
 * 2. String-based access: i18n.useKey("auth.validation.passwordMinLength")
 * 
 * Perfect for backend communication where you need keys, not translated values.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractTemplateParams, generateParamsInterface } from '../schema.js';

// =============================================================================
// TYPES (exported for external use)
// =============================================================================

export interface LocaleInfo {
  code: string;
  name: string;
  nativeName?: string;
  emoji?: string;
}

export interface I18nConfig {
  supportedLocales?: LocaleInfo[] | string[];
  fallbackLocale?: string;
  localeBasePath?: string; // e.g., '/src/locale', '/assets/i18n', etc.
}

/**
 * Generate type-safe accessor with dual access pattern
 * Each leaf provides both getKey() and getValue() methods
 */
function generateAccessorStructure(schema: Record<string, unknown>, path: string[] = []): string {
	if (schema.type === 'string') {
		const fullPath = path.join('.');
		
		// Check if this is a TemplateLiteral using our custom metadata
		if (schema['x-isTemplate'] === true && schema['x-template']) {
			const template = schema['x-template'] as string;
			const params = extractTemplateParams(template);
			const paramsInterface = generateParamsInterface(params);
			
			return `{
		getKey: () => '${fullPath}',
		getValue: (params: ${paramsInterface}) => {
			const template = get(currentLocale, '${fullPath}') as string;
			return interpolate(template, params);
		}
	}`;
		}
		
		// Regular string - no parameters needed
		return `{
		getKey: () => '${fullPath}',
		getValue: () => get(currentLocale, '${fullPath}') as string
	}`;
	}

	if (schema.type === 'object' && schema.properties) {
		const properties = Object.entries(schema.properties as Record<string, unknown>)
			.map(([key, value]) => {
				const accessor = generateAccessorStructure(value as Record<string, unknown>, [...path, key]);
				return `    ${key}: ${accessor}`;
			})
			.join(',\n');

		return `{\n${properties}\n  }`;
	}

	return `{
		getKey: () => '${path.join('.')}',
		getValue: () => '' // Fallback
	}`;
}

/**
 * Generate type-safe Svelte 5 i18n store with backend communication focus
 */
export function generateSvelteStore(
	schema: Record<string, unknown>,
	outputPath: string,
	typesImportPath: string = '../../../types/i18n.js'
): void {
	console.log('🔧 Generating Svelte 5 i18n store...');

	// Ensure directory exists
	mkdirSync(dirname(outputPath), { recursive: true });

	const accessorStructure = generateAccessorStructure(schema);

	const storeCode = `/**
 * 🌐 TypeScript-first i18n Store for Svelte 5
 *
 * Auto-generated from TypeBox schema - DO NOT EDIT MANUALLY
 * 
 * ⚡ Performance-First Design:
 * - 🚀 Lazy loading: Only loads locales when requested
 * - 📦 Configurable: You define which languages to support
 * - 🎯 Type-safe: Full TypeScript support with IntelliSense
 * 
 * 🛠️ Configuration (Recommended):
 *   \`\`\`typescript
 *   // Method 1: Configure default instance
 *   i18n.configureSupportedLocales(['en', 'es', 'fr']);
 *   await i18n.setLocale('es');
 *   
 *   // Method 2: Create configured instance  
 *   const i18n = createConfiguredI18n(['en', 'es', 'fr'], 'en');
 *   
 *   // Method 3: Context with config
 *   const i18n = setupI18n('en', { supportedLocales: ['en', 'es', 'fr'] });
 *   \`\`\`
 * 
 * ✨ Dual Access Patterns:
 * 
 * 🎯 Type-safe (for development & backend communication):
 *   \`\`\`typescript
 *   // Get translation key for backend
 *   const errorKey = i18n.t.auth.validation.passwordMinLength.getKey();
 *   // Returns: "auth.validation.passwordMinLength"
 *   
 *   // Get translated value for display
 *   const errorMsg = i18n.t.auth.validation.passwordMinLength.getValue();
 *   // Returns: "Password must be at least 8 characters"
 *   \`\`\`
 * 
 * 🔤 String-based (traditional):
 *   \`\`\`typescript
 *   const errorMsg = i18n.useKey('auth.validation.passwordMinLength');
 *   \`\`\`
 * 
 * 🚀 Lazy Loading Benefits:
 *   \`\`\`typescript
 *   // Only loads 'es.json' when this is called
 *   await i18n.setLocale('es');
 *   
 *   // No performance impact until explicitly requested
 *   \`\`\`
 */

import { getContext, setContext } from 'svelte';
import type { CeraUIKeys, DeepKeyPath } from '${typesImportPath}';

// =============================================================================
// TYPES
// =============================================================================

type LocaleData = Record<string, any>;
type TranslationParams = Record<string, string | number>;

interface I18nStore {
  locale: string;
  isLoading: boolean;
  
  // String-based access (traditional)
  useKey<K extends DeepKeyPath<CeraUIKeys>>(key: K, params?: TranslationParams): string;
  
  // Type-safe accessor structure
  t: typeof i18nAccessors;
  
  // Locale management (lazy loading)
  setLocale(locale: string): Promise<void>;
  getAvailableLocales(): string[];
  getAvailableLocalesWithInfo(): LocaleInfo[];
  isLocaleSupported(locale: string): boolean;
  getLocaleInfo(locale: string): LocaleInfo | null;
  
  // Configuration
  configureSupportedLocales(locales: LocaleInfo[] | string[]): void;
  setLocaleBasePath(path: string): void;
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Type-safe deep object property access
 */
function get<T>(obj: T, path: string): unknown {
  return path.split('.').reduce((current: any, key: string) => current?.[key], obj);
}

/**
 * Template literal interpolation with type safety
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/{(\\w+)}/g, (match, key) => {
    const value = params[key];
    return value !== undefined ? String(value) : match;
  });
}

// =============================================================================
// LOCALE DATA LOADING
// =============================================================================

const localeCache = new Map<string, LocaleData>();

// Configuration for supported locales and paths
let supportedLocales: LocaleInfo[] = [];
let localeBasePath: string = '/src/locale'; // Default path

async function loadLocaleData(locale: string): Promise<LocaleData> {
  if (localeCache.has(locale)) {
    return localeCache.get(locale)!;
  }
  
  try {
    // Use configurable base path
    const localePath = \`\${localeBasePath}/\${locale}.json\`;
    const localeModule = await import(localePath);
    const data = localeModule.default || localeModule;
    localeCache.set(locale, data);
    return data;
  } catch (error) {
    console.warn(\`Failed to load locale \${locale} from \${localeBasePath}, falling back to 'en'\`);
    
    // Fallback to English
    if (locale !== 'en') {
      return loadLocaleData('en');
    }
    
    throw new Error(\`Failed to load fallback locale 'en' from \${localeBasePath}\`);
  }
}

// Helper function to normalize locale configuration
function normalizeLocales(locales: LocaleInfo[] | string[]): LocaleInfo[] {
  return locales.map(locale => {
    if (typeof locale === 'string') {
      return { code: locale, name: locale.toUpperCase() };
    }
    return locale;
  });
}

// =============================================================================
// REACTIVE STATE
// =============================================================================

let currentLocale = $state<LocaleData>({});
let currentLanguage = $state<string>('en');
let isLoading = $state<boolean>(false);

// =============================================================================
// TYPE-SAFE ACCESSOR STRUCTURE
// =============================================================================

/**
 * Auto-generated nested accessor structure
 * Each leaf provides getKey() and getValue() methods for dual access
 */
const i18nAccessors = ${accessorStructure};

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

function createI18nStore(initialLocale: string = 'en', config: I18nConfig = {}): I18nStore {
  // Set supported locales from config
  if (config.supportedLocales) {
    supportedLocales = normalizeLocales(config.supportedLocales);
  }
  
  // Set locale base path from config
  if (config.localeBasePath) {
    localeBasePath = config.localeBasePath;
  }
  
  // Lazy load initial locale only when needed
  let initialized = false;
  
  const ensureInitialized = async () => {
    if (!initialized) {
      initialized = true;
      try {
        const data = await loadLocaleData(initialLocale);
        currentLocale = data;
        currentLanguage = initialLocale;
      } catch (error) {
        console.warn(\`Failed to initialize with locale \${initialLocale}\`, error);
      }
    }
  };
  
  return {
    get locale() {
      return currentLanguage;
    },
    
    get isLoading() {
      return isLoading;
    },
    
    useKey<K extends DeepKeyPath<CeraUIKeys>>(key: K, params?: TranslationParams): string {
      // Ensure initialized before accessing translations
      if (!initialized) {
        ensureInitialized();
        return key; // Return key as fallback while loading
      }
      
      const value = get(currentLocale, key);
      
      if (value === undefined) {
        console.warn(\`Translation key not found: \${key}\`);
        return key; // Return the key as fallback
      }
      
      if (typeof value !== 'string') {
        console.warn(\`Translation value is not a string: \${key}\`);
        return String(value);
      }
      
      // Handle template literals with parameters
      return params ? interpolate(value, params) : value;
    },
    
    t: i18nAccessors,
    
    async setLocale(locale: string): Promise<void> {
      // Check support only if we have configured supported locales
      if (supportedLocales.length > 0 && !this.isLocaleSupported(locale)) {
        throw new Error(\`Unsupported locale: \${locale}. Available: \${this.getAvailableLocales().join(', ')}\`);
      }
      
      if (locale === currentLanguage) {
        return; // Already set
      }
      
      isLoading = true;
      try {
        // Truly lazy load - only load when explicitly requested
        const data = await loadLocaleData(locale);
        currentLocale = data;
        currentLanguage = locale;
        initialized = true;
        console.log(\`🌍 Locale changed to: \${locale}\`);
      } catch (error) {
        console.error(\`Failed to set locale to \${locale}:\`, error);
        throw error;
      } finally {
        isLoading = false;
      }
    },
    
    getAvailableLocales(): string[] {
      return supportedLocales.map(locale => locale.code);
    },
    
    getAvailableLocalesWithInfo(): LocaleInfo[] {
      return [...supportedLocales];
    },
    
    isLocaleSupported(locale: string): boolean {
      // If no supported locales configured, we'll try to load any locale
      return supportedLocales.length === 0 || supportedLocales.some(l => l.code === locale);
    },
    
    getLocaleInfo(locale: string): LocaleInfo | null {
      return supportedLocales.find(l => l.code === locale) || null;
    },
    
    configureSupportedLocales(locales: LocaleInfo[] | string[]): void {
      supportedLocales = normalizeLocales(locales);
      console.log(\`📋 Configured supported locales: \${supportedLocales.map(l => l.code).join(', ')}\`);
    },
    
    setLocaleBasePath(path: string): void {
      localeBasePath = path;
      console.log(\`📁 Locale base path set to: \${path}\`);
    }
  };
}

// =============================================================================
// CONTEXT SYSTEM
// =============================================================================

const I18N_CONTEXT_KEY = Symbol('i18n');

export function setupI18n(initialLocale: string = 'en', config: I18nConfig = {}): I18nStore {
  const store = createI18nStore(initialLocale, config);
  setContext(I18N_CONTEXT_KEY, store);
  return store;
}

export function useI18n(): I18nStore {
  const store = getContext<I18nStore>(I18N_CONTEXT_KEY);
  if (!store) {
    throw new Error('i18n store not found. Make sure to call setupI18n() in a parent component.');
  }
  return store;
}

// =============================================================================
// DEFAULT EXPORT & CONFIGURATION
// =============================================================================

/**
 * Default i18n instance for use across the application
 * Configure supported locales using: i18n.configureSupportedLocales(['en', 'es', 'fr'])
 */
export const i18n = createI18nStore();

/**
 * Helper function to create a configured i18n store
 */
export function createConfiguredI18n(
  supportedLocales: LocaleInfo[] | string[], 
  initialLocale: string = 'en',
  localeBasePath?: string
): I18nStore {
  return createI18nStore(initialLocale, { supportedLocales, localeBasePath });
}
`;

	writeFileSync(outputPath, storeCode);
	console.log(`✅ Generated Svelte 5 store: ${outputPath}`);
}