#!/usr/bin/env tsx

/**
 * CeraUI i18n Validation System
 * 
 * Comprehensive validation tool for internationalization files that ensures:
 * - Structure consistency across all language files
 * - Detection of unused translation keys
 * - Missing translations identification
 * - Usage validation in codebase
 * 
 * Built with MCP architecture principles for maximum efficiency and maintainability.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { glob } from 'glob';

interface ValidationResult {
  success: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  stats: ValidationStats;
  recommendations: Recommendation[];
}

interface ValidationError {
  type: 'structure' | 'missing' | 'usage' | 'format';
  language: string;
  key?: string;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface ValidationWarning {
  type: 'unused' | 'inconsistent' | 'potential';
  language: string;
  key?: string;
  message: string;
  confidence: number; // 0-100
}

interface ValidationStats {
  totalLanguages: number;
  totalKeys: number;
  keysUsedInCode: number;
  potentiallyUnusedKeys: number;
  missingTranslations: number;
  structuralInconsistencies: number;
}

interface Recommendation {
  type: 'cleanup' | 'translation' | 'structure';
  priority: 'high' | 'medium' | 'low';
  description: string;
  action: string;
}

class I18nValidator {
  private localeDir: string;
  private srcDir: string;
  private languages: Map<string, any> = new Map();
  private usedKeys: Set<string> = new Set();
  private allKeys: Set<string> = new Set();

  constructor(localeDir: string, srcDir: string) {
    this.localeDir = localeDir;
    this.srcDir = srcDir;
  }

  async validate(): Promise<ValidationResult> {
    console.log('🔍 Starting comprehensive i18n validation...\n');

    // Load all language files
    await this.loadLanguages();

    // Scan codebase for usage
    await this.scanCodebaseUsage();

    // Perform validations
    const structureValidation = this.validateStructure();
    const usageValidation = this.validateUsage();
    const consistencyValidation = this.validateConsistency();

    // Generate recommendations
    const recommendations = this.generateRecommendations();

    const result: ValidationResult = {
      success: structureValidation.length === 0 && usageValidation.length === 0,
      errors: [...structureValidation, ...usageValidation],
      warnings: consistencyValidation,
      stats: this.generateStats(),
      recommendations
    };

    this.printReport(result);
    return result;
  }

  private async loadLanguages(): Promise<void> {
    console.log('📂 Loading language files...');
    
    const files = readdirSync(this.localeDir)
      .filter(file => extname(file) === '.json' && !file.includes('.bak'));

    for (const file of files) {
      const langCode = file.replace('.json', '');
      const filePath = join(this.localeDir, file);
      
      try {
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        this.languages.set(langCode, data);
        
        // Collect all keys from this language
        this.collectKeys(data, '', langCode);
        
        console.log(`   ✓ Loaded ${langCode} (${Object.keys(this.flattenObject(data)).length} keys)`);
      } catch (error) {
        console.error(`   ✗ Failed to load ${langCode}: ${error.message}`);
      }
    }
    
    console.log(`📊 Loaded ${this.languages.size} languages with ${this.allKeys.size} unique keys\n`);
  }

  private collectKeys(obj: any, prefix: string, langCode: string): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      this.allKeys.add(fullKey);
      
      if (typeof value === 'object' && value !== null) {
        this.collectKeys(value, fullKey, langCode);
      }
    }
  }

  private async scanCodebaseUsage(): Promise<void> {
    console.log('🔎 Scanning codebase for i18n usage...');
    
    // Find all .svelte, .ts, and .js files
    const patterns = [
      `${this.srcDir}/**/*.svelte`,
      `${this.srcDir}/**/*.ts`,
      `${this.srcDir}/**/*.js`
    ];

    let totalFiles = 0;
    let filesWithI18n = 0;

    for (const pattern of patterns) {
      const files = await glob(pattern, { ignore: ['**/node_modules/**'] });
      
      for (const file of files) {
        totalFiles++;
        const content = readFileSync(file, 'utf-8');
        const usage = this.extractI18nUsage(content);
        
        if (usage.length > 0) {
          filesWithI18n++;
          usage.forEach(key => this.usedKeys.add(key));
        }
      }
    }

    console.log(`   📁 Scanned ${totalFiles} files`);
    console.log(`   🎯 Found i18n usage in ${filesWithI18n} files`);
    console.log(`   🔑 Detected ${this.usedKeys.size} unique keys in use\n`);
  }  private extractI18nUsage(content: string): string[] {
    const keys: string[] = [];
    
    // Pattern for $_('key.path') usage
    const basicPattern = /\$_\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let match;
    
    while ((match = basicPattern.exec(content)) !== null) {
      keys.push(match[1]);
    }

    // Pattern for dynamic keys with template strings
    const templatePattern = /\$_\s*\(\s*`([^`]+)`\s*\)/g;
    while ((match = templatePattern.exec(content)) !== null) {
      // Extract static parts of template strings
      const templateKey = match[1];
      if (!templateKey.includes('${')) {
        keys.push(templateKey);
      } else {
        // For dynamic keys, try to extract the base pattern
        const baseKey = templateKey.split('${')[0];
        if (baseKey) {
          keys.push(baseKey.trim());
        }
      }
    }

    return keys;
  }

  private validateStructure(): ValidationError[] {
    console.log('🏗️  Validating structure consistency...');
    const errors: ValidationError[] = [];
    
    if (this.languages.size === 0) {
      errors.push({
        type: 'structure',
        language: 'all',
        message: 'No language files found',
        severity: 'critical'
      });
      return errors;
    }    // Use English as the reference structure
    const referenceLang = 'en';
    const reference = this.languages.get(referenceLang);
    
    if (!reference) {
      errors.push({
        type: 'structure',
        language: referenceLang,
        message: 'Reference language (English) not found',
        severity: 'critical'
      });
      return errors;
    }

    const referenceKeys = new Set(Object.keys(this.flattenObject(reference)));

    // Compare each language against the reference
    for (const [langCode, langData] of this.languages) {
      if (langCode === referenceLang) continue;

      const langKeys = new Set(Object.keys(this.flattenObject(langData)));
      
      // Check for missing keys
      for (const key of referenceKeys) {
        if (!langKeys.has(key)) {
          errors.push({
            type: 'missing',
            language: langCode,
            key,
            message: `Missing translation for key: ${key}`,
            severity: 'high'
          });
        }
      }

      // Check for extra keys (that don't exist in reference)
      for (const key of langKeys) {
        if (!referenceKeys.has(key)) {
          errors.push({
            type: 'structure',
            language: langCode,
            key,
            message: `Extra key not found in reference: ${key}`,
            severity: 'medium'
          });
        }
      }
    }

    console.log(`   ${errors.length === 0 ? '✓' : '⚠️'}  Found ${errors.length} structural issues\n`);
    return errors;
  }

  private validateUsage(): ValidationError[] {
    console.log('🎯 Validating key usage...');
    const errors: ValidationError[] = [];

    // Check if used keys exist in language files
    const referenceLang = this.languages.get('en');
    if (!referenceLang) return errors;

    const availableKeys = new Set(Object.keys(this.flattenObject(referenceLang)));

    for (const usedKey of this.usedKeys) {
      if (!availableKeys.has(usedKey)) {
        errors.push({
          type: 'usage',
          language: 'en',
          key: usedKey,
          message: `Used key not found in translations: ${usedKey}`,
          severity: 'critical'
        });
      }
    }

    console.log(`   ${errors.length === 0 ? '✓' : '⚠️'}  Found ${errors.length} usage issues\n`);
    return errors;
  }

  private validateConsistency(): ValidationWarning[] {
    console.log('⚖️  Checking consistency and unused keys...');
    const warnings: ValidationWarning[] = [];

    const referenceLang = this.languages.get('en');
    if (!referenceLang) return warnings;

    const availableKeys = new Set(Object.keys(this.flattenObject(referenceLang)));

    // Find potentially unused keys
    for (const key of availableKeys) {
      if (!this.usedKeys.has(key)) {
        // Calculate confidence based on key patterns
        let confidence = 70; // Base confidence

        // Lower confidence for keys that might be dynamically constructed
        if (key.includes('toast') || key.includes('error') || key.includes('placeholder')) {
          confidence = 40;
        }

        // Higher confidence for keys in sections like devtools that might be conditional
        if (key.startsWith('devtools.')) {
          confidence = 30;
        }

        warnings.push({
          type: 'unused',
          language: 'all',
          key,
          message: `Potentially unused key: ${key}`,
          confidence
        });
      }
    }

    console.log(`   🔍 Found ${warnings.length} potentially unused keys\n`);
    return warnings;
  }

  private generateRecommendations(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check for severely incomplete translations
    const referenceLang = this.languages.get('en');
    if (referenceLang) {
      const referenceCount = Object.keys(this.flattenObject(referenceLang)).length;

      for (const [langCode, langData] of this.languages) {
        if (langCode === 'en') continue;
        
        const langCount = Object.keys(this.flattenObject(langData)).length;
        const completeness = (langCount / referenceCount) * 100;
        
        if (completeness < 50) {
          recommendations.push({
            type: 'translation',
            priority: 'high',
            description: `${langCode} translation is severely incomplete (${completeness.toFixed(1)}%)`,
            action: `Complete missing translations for ${langCode} - ${referenceCount - langCount} keys missing`
          });
        }
      }
    }

    // Recommend cleanup for high-confidence unused keys
    const highConfidenceUnused = this.allKeys.size - this.usedKeys.size;
    if (highConfidenceUnused > 10) {
      recommendations.push({
        type: 'cleanup',
        priority: 'medium',
        description: `${highConfidenceUnused} potentially unused keys detected`,
        action: 'Review and remove unused translation keys to reduce bundle size'
      });
    }

    return recommendations;
  }

  private generateStats(): ValidationStats {
    const referenceLang = this.languages.get('en');
    const totalKeys = referenceLang ? Object.keys(this.flattenObject(referenceLang)).length : 0;

    return {
      totalLanguages: this.languages.size,
      totalKeys,
      keysUsedInCode: this.usedKeys.size,
      potentiallyUnusedKeys: totalKeys - this.usedKeys.size,
      missingTranslations: 0, // This would be calculated from structure validation
      structuralInconsistencies: 0 // This would be calculated from structure validation
    };
  }

  private flattenObject(obj: any, prefix = ''): Record<string, any> {
    const flattened: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(flattened, this.flattenObject(value, newKey));
      } else {
        flattened[newKey] = value;
      }
    }
    
    return flattened;
  }

  private printReport(result: ValidationResult): void {
    console.log('📊 VALIDATION REPORT');
    console.log('═'.repeat(50));
    
    // Overall status
    console.log(`Overall Status: ${result.success ? '✅ PASS' : '❌ FAIL'}`);
    console.log();

    // Statistics
    console.log('📈 STATISTICS');
    console.log(`Languages: ${result.stats.totalLanguages}`);
    console.log(`Total Keys: ${result.stats.totalKeys}`);
    console.log(`Keys Used in Code: ${result.stats.keysUsedInCode}`);
    console.log(`Potentially Unused: ${result.stats.potentiallyUnusedKeys}`);
    console.log();

    // Errors
    if (result.errors.length > 0) {
      console.log('🚨 ERRORS');
      for (const error of result.errors) {
        console.log(`${this.getSeverityIcon(error.severity)} [${error.language}] ${error.message}`);
        if (error.key) console.log(`   Key: ${error.key}`);
      }
      console.log();
    }

    // Warnings
    if (result.warnings.length > 0) {
      console.log('⚠️  WARNINGS');
      const highConfidenceWarnings = result.warnings.filter(w => w.confidence > 60);
      console.log(`Showing ${highConfidenceWarnings.length} high-confidence warnings (${result.warnings.length} total)`);
      
      for (const warning of highConfidenceWarnings.slice(0, 10)) {
        console.log(`${this.getConfidenceIcon(warning.confidence)} ${warning.message} (${warning.confidence}%)`);
      }
      if (highConfidenceWarnings.length > 10) {
        console.log(`   ... and ${highConfidenceWarnings.length - 10} more`);
      }
      console.log();
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      console.log('💡 RECOMMENDATIONS');
      for (const rec of result.recommendations) {
        console.log(`${this.getPriorityIcon(rec.priority)} ${rec.description}`);
        console.log(`   Action: ${rec.action}`);
      }
      console.log();
    }

    console.log('═'.repeat(50));
    console.log(`Validation completed. ${result.success ? 'No critical issues found.' : 'Issues detected - see above for details.'}`);
  }

  private getSeverityIcon(severity: string): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🔵';
      default: return '⚪';
    }
  }

  private getConfidenceIcon(confidence: number): string {
    if (confidence >= 80) return '🔴';
    if (confidence >= 60) return '🟠';
    if (confidence >= 40) return '🟡';
    return '🔵';
  }

  private getPriorityIcon(priority: string): string {
    switch (priority) {
      case 'high': return '🔴';
      case 'medium': return '🟡';
      case 'low': return '🔵';
      default: return '⚪';
    }
  }
}

// CLI execution
async function main() {
  const localeDir = join(process.cwd(), 'src/locale');
  const srcDir = join(process.cwd(), 'src');

  if (!existsSync(localeDir)) {
    console.error('❌ Locale directory not found. Please run from project root.');
    process.exit(1);
  }

  const validator = new I18nValidator(localeDir, srcDir);
  const result = await validator.validate();

  // Exit with error code if validation failed
  process.exit(result.success ? 0 : 1);
}

if (require.main === module) {
  main().catch(console.error);
}

export { I18nValidator, ValidationResult };