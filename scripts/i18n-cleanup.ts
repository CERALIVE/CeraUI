#!/usr/bin/env tsx

/**
 * CeraUI i18n Cleanup Tool
 * 
 * Safely removes unused translation keys from language files based on
 * high-confidence analysis from the i18n validator.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { I18nValidator } from './i18n-validator';

interface CleanupOptions {
  dryRun: boolean;
  minConfidence: number;
  backup: boolean;
}

class I18nCleaner {
  private localeDir: string;
  private srcDir: string;
  private options: CleanupOptions;

  constructor(localeDir: string, srcDir: string, options: CleanupOptions) {
    this.localeDir = localeDir;
    this.srcDir = srcDir;
    this.options = options;
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Starting i18n cleanup process...\n');

    // First run validation to get unused keys
    const validator = new I18nValidator(this.localeDir, this.srcDir);
    const result = await validator.validate();

    // Filter high-confidence unused keys
    const unusedKeys = result.warnings
      .filter(w => w.type === 'unused' && w.confidence >= this.options.minConfidence)
      .map(w => w.key!)
      .filter(Boolean);

    if (unusedKeys.length === 0) {
      console.log('✅ No high-confidence unused keys found. Nothing to clean up.');
      return;
    }

    console.log(`🎯 Found ${unusedKeys.length} unused keys with ≥${this.options.minConfidence}% confidence\n`);

    if (this.options.dryRun) {
      console.log('🔍 DRY RUN - Keys that would be removed:');
      unusedKeys.forEach(key => console.log(`   - ${key}`));
      console.log('\nRun without --dry-run to actually remove these keys.');
      return;
    }

    // Remove keys from all language files
    await this.removeKeysFromLanguages(unusedKeys);
    
    console.log('✅ Cleanup completed successfully!');
  }  private async removeKeysFromLanguages(keysToRemove: string[]): Promise<void> {
    console.log('🔧 Removing unused keys from language files...\n');

    for (const [langCode, langData] of await this.loadLanguages()) {
      if (this.options.backup) {
        const backupPath = join(this.localeDir, `${langCode}.json.backup`);
        writeFileSync(backupPath, JSON.stringify(langData, null, 2));
        console.log(`   💾 Created backup: ${backupPath}`);
      }

      const cleanedData = this.removeKeysFromObject(langData, keysToRemove);
      const outputPath = join(this.localeDir, `${langCode}.json`);
      
      writeFileSync(outputPath, JSON.stringify(cleanedData, null, 2) + '\n');
      console.log(`   ✓ Cleaned ${langCode}.json`);
    }
  }

  private async loadLanguages(): Promise<Array<[string, any]>> {
    const validator = new I18nValidator(this.localeDir, this.srcDir);
    await validator['loadLanguages'](); // Access private method
    return Array.from(validator['languages'].entries());
  }

  private removeKeysFromObject(obj: any, keysToRemove: string[]): any {
    const result = JSON.parse(JSON.stringify(obj)); // Deep clone

    for (const keyPath of keysToRemove) {
      this.deleteNestedKey(result, keyPath);
    }

    return result;
  }

  private deleteNestedKey(obj: any, keyPath: string): void {
    const keys = keyPath.split('.');
    let current = obj;

    // Navigate to parent of target key
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] === undefined) return;
      current = current[keys[i]];
    }

    // Delete the target key
    const finalKey = keys[keys.length - 1];
    delete current[finalKey];

    // Clean up empty parent objects
    this.cleanupEmptyParents(obj, keys.slice(0, -1));
  }  private cleanupEmptyParents(obj: any, keyPath: string[]): void {
    if (keyPath.length === 0) return;

    let current = obj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      current = current[keyPath[i]];
    }

    const targetKey = keyPath[keyPath.length - 1];
    if (current[targetKey] && Object.keys(current[targetKey]).length === 0) {
      delete current[targetKey];
      this.cleanupEmptyParents(obj, keyPath.slice(0, -1));
    }
  }
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  
  const options: CleanupOptions = {
    dryRun: args.includes('--dry-run'),
    minConfidence: parseInt(args.find(arg => arg.startsWith('--confidence='))?.split('=')[1] || '80'),
    backup: !args.includes('--no-backup')
  };

  const localeDir = join(process.cwd(), 'src/locale');
  const srcDir = join(process.cwd(), 'src');

  const cleaner = new I18nCleaner(localeDir, srcDir, options);
  await cleaner.cleanup();
}

if (require.main === module) {
  main().catch(console.error);
}

export { I18nCleaner };