/**
 * @ceraui/i18n-typebox
 * 
 * TypeScript-first i18n system with TypeBox schema definition and framework adapters
 */

// =============================================================================
// CORE SCHEMA UTILITIES
// =============================================================================

export {
	TemplateLiteral,
	defineI18nSchema,
	extractTemplateParams,
	generateParamsInterface,
	interpolate,
	get,
	Type
} from './schema.js';

export type {
	Static,
	DeepKeyPath,
	ValueAtPath,
	TemplateParams,
	InferI18nSchema
} from './schema.js';

// =============================================================================
// GENERATORS
// =============================================================================

export { generateJsonSchema } from './generators/json-schema.js';

// =============================================================================
// VALIDATION
// =============================================================================

export { validateLocaleFiles } from './validation.js';

// =============================================================================
// ADAPTERS (Framework-specific)
// =============================================================================

export { generateSvelteStore } from './adapters/svelte.js';
export type { LocaleInfo, I18nConfig } from './adapters/svelte.js';

// =============================================================================
// CLI COMMANDS (for programmatic usage)
// =============================================================================

export { generateCommand } from './cli/commands/generate.js';
export { validateCommand } from './cli/commands/validate.js';
export { analyzeCommand } from './cli/commands/analyze.js';
export { detectProjectConfig, validateConfig } from './cli/utils/config.js';
export type { ProjectConfig } from './cli/utils/config.js';
