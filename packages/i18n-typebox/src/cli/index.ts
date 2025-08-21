#!/usr/bin/env node

/**
 * @ceraui/i18n-typebox CLI
 *
 * TypeScript-first i18n code generation and validation tool
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get package version
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

function showVersion() {
	console.log(`@ceraui/i18n-typebox v${packageJson.version}`);
}

function showHelp() {
	console.log(`
🌐 @ceraui/i18n-typebox v${packageJson.version}
TypeScript-first i18n code generation and validation tool

Usage:
  i18n-typebox <command> [options]

Commands:
  generate    Generate JSON schema and framework adapters from TypeBox schema
  validate    Validate locale files against the generated JSON schema
  fix         Add missing keys with translation placeholders (duplicates require manual review)
  analyze     Analyze TypeScript code for i18n key usage and detect unused keys
  help        Show this help message
  version     Show version information

Examples:
  i18n-typebox generate                    # Generate all files
  i18n-typebox validate                    # Validate locale files
  i18n-typebox fix                         # Add missing keys safely
  i18n-typebox fix --dry-run               # Preview missing key additions
  i18n-typebox analyze                     # Analyze key usage

For more information, visit: https://github.com/CERALIVE/CeraUI
`);
}

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	try {
		switch (command) {
			case 'generate': {
				const { generateCommand } = await import('./commands/generate.js');
				await generateCommand(args.slice(1));
				break;
			}

			case 'validate': {
				const { validateCommand } = await import('./commands/validate.js');
				await validateCommand(args.slice(1));
				break;
			}

			case 'fix': {
				const { fixCommand } = await import('./commands/fix.js');
				await fixCommand(args.slice(1));
				break;
			}

			case 'analyze': {
				const { analyzeCommand } = await import('./commands/analyze.js');
				await analyzeCommand(args.slice(1));
				break;
			}

			case 'version':
				showVersion();
				break;

			case 'help':
			case '--help':
			case '-h':
				showHelp();
				break;

			default:
				if (!command) {
					showHelp();
				} else {
					console.error(`❌ Unknown command: ${command}`);
					console.log('Run "i18n-typebox help" for usage information.');
					process.exit(1);
				}
		}
	} catch (error) {
		console.error('❌ Command failed:', error);
		process.exit(1);
	}
}

// Run CLI
main().catch(console.error);
