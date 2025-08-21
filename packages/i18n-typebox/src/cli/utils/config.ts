/**
 * Configuration detection and project structure utilities
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface ProjectConfig {
  schemaPath: string;
  localeDirectory: string;
  outputDirectory: string;
  schemaOutputPath: string;
  projectRoot: string;
}

/**
 * Auto-detect project configuration
 */
export function detectProjectConfig(cwd: string = process.cwd()): ProjectConfig {
  const projectRoot = findProjectRoot(cwd);
  
  // Try to find schema file
  const schemaPaths = [
    'types/ceraui-i18n.ts',
    'types/i18n.ts',
    'src/i18n/schema.ts',
    'src/schema/i18n.ts'
  ];
  
  let schemaPath = '';
  for (const path of schemaPaths) {
    const fullPath = join(projectRoot, path);
    if (existsSync(fullPath)) {
      schemaPath = fullPath;
      break;
    }
  }
  
  if (!schemaPath) {
    throw new Error(`❌ Could not find i18n schema file. Tried: ${schemaPaths.join(', ')}`);
  }
  
  // Try to find locale directory
  const localePaths = [
    'apps/frontend/src/locale',
    'src/locale', 
    'locale',
    'locales',
    'src/locales'
  ];
  
  let localeDirectory = '';
  for (const path of localePaths) {
    const fullPath = join(projectRoot, path);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      localeDirectory = fullPath;
      break;
    }
  }
  
  if (!localeDirectory) {
    throw new Error(`❌ Could not find locale directory. Tried: ${localePaths.join(', ')}`);
  }
  
  // Determine output paths
  const outputDirectory = join(localeDirectory, '../lib/stores');
  const schemaOutputPath = join(localeDirectory, 'locale.schema.json');
  
  return {
    schemaPath,
    localeDirectory,
    outputDirectory,
    schemaOutputPath,
    projectRoot
  };
}

/**
 * Find project root by looking for package.json
 */
function findProjectRoot(startPath: string): string {
  let currentPath = resolve(startPath);
  
  while (currentPath !== '/') {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath;
    }
    currentPath = resolve(currentPath, '..');
  }
  
  throw new Error('❌ Could not find project root (no package.json found)');
}

/**
 * Validate that paths exist and are accessible
 */
export function validateConfig(config: ProjectConfig): void {
  if (!existsSync(config.schemaPath)) {
    throw new Error(`❌ Schema file not found: ${config.schemaPath}`);
  }
  
  if (!existsSync(config.localeDirectory)) {
    throw new Error(`❌ Locale directory not found: ${config.localeDirectory}`);
  }
  
  console.log('🔍 Project configuration:');
  console.log(`   📄 Schema: ${config.schemaPath}`);
  console.log(`   📂 Locales: ${config.localeDirectory}`);
  console.log(`   🏗️  Output: ${config.outputDirectory}`);
}