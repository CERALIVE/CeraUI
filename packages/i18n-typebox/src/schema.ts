/**
 * TypeBox-based i18n Schema Utilities
 * 
 * Framework-agnostic core for TypeScript-first internationalization
 * with compile-time validation and auto-generation support.
 */

import { type Static, Type } from '@sinclair/typebox';

// =============================================================================
// TEMPLATE LITERAL HELPER
// =============================================================================

/**
 * Template literal type for strings with parameter interpolation
 * Example: "Hello {name}!" becomes TemplateLiteral("Hello {name}!")
 */
export const TemplateLiteral = (template: string) =>
	Type.String({
		pattern: `^${template.replace(/{[^}]+}/g, '.*')}$`,
		description: `Template: ${template}`,
		// Store the original template for code generation
		'x-template': template,
		'x-isTemplate': true,
	});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Extract parameter names from a template literal pattern
 * Example: "Hello {name}! You have {count} messages" → ["name", "count"]
 */
export function extractTemplateParams(pattern: string): string[] {
	const matches = pattern.match(/{(\w+)}/g);
	return matches ? matches.map((match) => match.slice(1, -1)) : [];
}

/**
 * Generate TypeScript interface for template parameters
 * Example: ["name", "count"] → "{ name: string | number; count: string | number }"
 */
export function generateParamsInterface(params: string[]): string {
	if (params.length === 0) return '{}';
	const paramTypes = params.map((param) => `${param}: string | number`).join('; ');
	return `{ ${paramTypes} }`;
}

/**
 * Template literal interpolation with type safety
 */
export function interpolate(template: string, params: Record<string, string | number>): string {
	return template.replace(/{(\w+)}/g, (match, key) => {
		const value = params[key];
		return value !== undefined ? String(value) : match;
	});
}

/**
 * Type-safe deep object property access
 */
export function get<T>(obj: T, path: string): unknown {
	return path.split('.').reduce((current: any, key: string) => current?.[key], obj);
}

// =============================================================================
// TYPE UTILITIES
// =============================================================================

/**
 * Extract all possible deep key paths as literal types
 * Example: "updatingOverlay.title" | "devtools.systemInfo" | etc.
 */
export type DeepKeyPath<T, P extends string = ''> = {
	[K in keyof T]: K extends string
		? T[K] extends Record<string, unknown>
			? `${P}${K}` | DeepKeyPath<T[K], `${P}${K}.`>
			: `${P}${K}`
		: never;
}[keyof T];

/**
 * Extract value type for a given key path
 */
export type ValueAtPath<T, P extends string> = P extends `${infer K}.${infer R}`
	? K extends keyof T
		? ValueAtPath<T[K], R>
		: never
	: P extends keyof T
		? T[P]
		: never;

/**
 * Parameters for template literals (if any)
 * Used for strings that contain {param} interpolation
 */
export type TemplateParams<T extends string> = T extends `${string}{${infer P}}${infer R}`
	? P | TemplateParams<R>
	: never;

// =============================================================================
// SCHEMA DEFINITION HELPERS
// =============================================================================

/**
 * Create a typed i18n schema with full type inference
 */
export function defineI18nSchema(
	schema: Record<string, any>,
	options?: {
		title?: string;
		description?: string;
		additionalProperties?: boolean;
	}
) {
	return Type.Object(schema, {
		title: options?.title || 'I18n Translation Schema',
		description: options?.description || 'Translation structure for the application',
		additionalProperties: options?.additionalProperties ?? false,
	});
}

/**
 * Extract TypeScript type from TypeBox schema
 */
export type InferI18nSchema<T> = T extends ReturnType<typeof defineI18nSchema>
	? Static<T>
	: never;

// =============================================================================
// EXPORTS
// =============================================================================

export { Type } from '@sinclair/typebox';
export type { Static } from '@sinclair/typebox';
