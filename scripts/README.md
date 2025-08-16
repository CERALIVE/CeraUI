# CeraUI i18n Validation System

A comprehensive internationalization validation and maintenance system built with MCP architecture principles.

## 🎯 Features

- **Structure Validation**: Ensures all language files have consistent key structures
- **Usage Detection**: Scans codebase to find all used translation keys
- **Unused Key Detection**: Identifies potentially unused keys with confidence scoring
- **Missing Translation Detection**: Finds missing translations across languages
- **Automated Cleanup**: Safely removes unused keys with backup support
- **CI/CD Integration**: GitHub Actions workflow for automatic validation

## 🚀 Quick Start

### Installation

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "i18n:validate": "tsx scripts/i18n-validator.ts",
    "i18n:cleanup": "tsx scripts/i18n-cleanup.ts",
    "i18n:cleanup-dry": "tsx scripts/i18n-cleanup.ts --dry-run",
    "i18n:cleanup-safe": "tsx scripts/i18n-cleanup.ts --confidence=90",
    "i18n:check": "npm run i18n:validate && echo 'All i18n validations passed!'",
    "i18n:fix": "npm run i18n:cleanup-safe && npm run i18n:validate"
  }
}
```

### Dependencies

```bash
pnpm add -D tsx glob @types/node
```

## 📖 Usage

### Validate Translations

```bash
# Run comprehensive validation
npm run i18n:validate

# Quick check (exits with error if issues found)
npm run i18n:check
```

### Clean Up Unused Keys

```bash
# Dry run - see what would be removed
npm run i18n:cleanup-dry

# Safe cleanup (90% confidence threshold)
npm run i18n:cleanup-safe

# Aggressive cleanup (80% confidence threshold)
npm run i18n:cleanup

# Custom confidence threshold
tsx scripts/i18n-cleanup.ts --confidence=95
```

### Fix Common Issues

```bash
# Auto-fix safe issues and validate
npm run i18n:fix
```## 🔍 Validation Details

### Structure Validation
- Compares all language files against English (reference)
- Detects missing translations
- Identifies extra keys not in reference
- Reports structural inconsistencies

### Usage Detection
- Scans `.svelte`, `.ts`, and `.js` files
- Finds `$_('key.path')` patterns
- Handles template strings and dynamic keys
- Identifies keys used in code vs. available translations

### Confidence Scoring
- **High (80-100%)**: Very likely unused
- **Medium (60-79%)**: Probably unused
- **Low (40-59%)**: Possibly unused (toast, error, placeholder keys)
- **Very Low (0-39%)**: Likely used conditionally (devtools keys)

## 🛠️ Configuration

### Cleanup Options
- `--dry-run`: Preview changes without modifying files
- `--confidence=N`: Set minimum confidence threshold (default: 80)
- `--no-backup`: Skip creating backup files

### CI/CD Integration

The system includes GitHub Actions workflow that:
- Runs on PR changes to locale files
- Validates i18n structure automatically
- Comments on PRs if issues are found
- Prevents deployment of broken translations

## 📊 Understanding Reports

### Example Output
```
📊 VALIDATION REPORT
══════════════════════════════════════════════════
Overall Status: ❌ FAIL

📈 STATISTICS
Languages: 10
Total Keys: 650
Keys Used in Code: 580
Potentially Unused: 70

🚨 ERRORS
🔴 [zh] Missing translation for key: devtools.title

⚠️  WARNINGS
🟠 Potentially unused key: settings.oldFeature (85%)
🟡 Potentially unused key: toast.deprecated (65%)

💡 RECOMMENDATIONS
🔴 zh translation is severely incomplete (7.4%)
   Action: Complete missing translations for zh - 602 keys missing
🟡 70 potentially unused keys detected
   Action: Review and remove unused translation keys to reduce bundle size
```## 🔧 Setup Pre-commit Hook

```bash
# Copy the pre-commit hook
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## 🎯 Best Practices

### Development Workflow
1. **Before committing**: Run `npm run i18n:check`
2. **After adding new keys**: Ensure they're translated in all languages
3. **Regular cleanup**: Run `npm run i18n:cleanup-dry` monthly
4. **Safe cleanup**: Use `npm run i18n:cleanup-safe` for automated cleanup

### Translation Guidelines
- Use English (`en.json`) as the reference structure
- Maintain consistent key hierarchies across all languages
- Use descriptive key names that indicate their usage context
- Group related keys under logical sections

### Key Naming Conventions
```typescript
// Good
"devtools.toastTester.description"
"network.wifi.connectionStatus.connected"
"validation.errors.passwordMinLength"

// Avoid
"dt_toast_desc"
"wifiConnected"
"pwdErr1"
```

## 🚨 Troubleshooting

### Common Issues

**"Used key not found in translations"**
- Key is used in code but doesn't exist in language files
- Add the missing key to all language files

**"Missing translation for key"**
- Key exists in English but missing in other languages
- Add translation to the specific language file

**"zh translation is severely incomplete"**
- Chinese translation file is missing most keys
- This is a known issue in the current codebase

### False Positives

Some keys might be marked as unused but are actually used:
- Dynamic key construction: `$_(\`status.\${currentStatus}\`)`
- Conditional usage in development mode
- Keys used in external integrations

Use higher confidence thresholds or manually review before cleanup.

## 🔄 Maintenance

- Run validation before releases
- Monitor CI/CD reports for degradation
- Update confidence thresholds based on false positive rates
- Regular review of cleanup recommendations

---

Built with MCP architecture principles for maximum efficiency and maintainability.