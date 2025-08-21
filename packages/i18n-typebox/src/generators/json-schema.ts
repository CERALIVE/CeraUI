/**
 * JSON Schema Generator
 * 
 * Generates JSON Schema from TypeBox definitions for validation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Generate JSON Schema from TypeBox definition
 */
export function generateJsonSchema(
	schema: Record<string, unknown>,
	outputPath: string
): void {
	console.log('🔧 Generating JSON Schema from TypeBox definition...');
	
	// Ensure directory exists
	mkdirSync(dirname(outputPath), { recursive: true });
	
	const jsonSchema = {
		$schema: 'http://json-schema.org/draft-07/schema#',
		...schema,
		properties: {
			// Explicitly allow $schema property in JSON files
			$schema: {
				type: 'string',
				description: 'JSON Schema reference'
			},
			...((schema.properties as Record<string, unknown>) || {})
		}
	};
	
	writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));
	console.log(`✅ Generated JSON Schema: ${outputPath}`);
}
