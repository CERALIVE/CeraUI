# 🌐 Internationalization (i18n) Validation System

This document describes the comprehensive locale validation system for CeraUI, which ensures consistency across all translation files and prevents missing translations.

## 📋 Overview

The i18n validation system consists of three main components:

1. **JSON Schema Generator** - Creates a schema from the English locale (master reference)
2. **Locale Validator** - Validates all locale files against the generated schema
3. **Locale Comparator** - Provides detailed analysis and statistics about translation completeness

## 🚀 Quick Start

```bash
# Validate all locale files (generates schema automatically)
pnpm i18n:check

# Compare locales and show statistics
pnpm i18n:compare

# Validate specific locale file
pnpm i18n:validate --file=es.json

# Analyze specific locale in detail
pnpm i18n:compare --locale=es
```

## 📦 Available Commands

| Command | Description | Example |
|---------|-------------|---------|
| `pnpm i18n:schema` | Generate JSON schema from English locale | `pnpm i18n:schema` |
| `pnpm i18n:validate` | Validate all locale files | `pnpm i18n:validate` |
| `pnpm i18n:compare` | Show completion statistics and analysis | `pnpm i18n:compare` |
| `pnpm i18n:check` | Full validation with schema generation | `pnpm i18n:check` |
| `pnpm i18n:setup` | Add schema references to all locale files | `pnpm i18n:setup` |

### Command Options

**Validation Options:**
```bash
# Validate single file
pnpm i18n:validate --file=es.json

# Generate schema before validating
pnpm i18n:validate --generate-schema
```

**Comparison Options:**
```bash
# Analyze specific locale
pnpm i18n:compare --locale=es

# Show detailed missing keys for French
pnpm i18n:compare --locale=fr
```

## 📊 Understanding the Output

### Validation Output

```bash
🔍 Validating: es.json
❌ es.json: INVALID
   $.auth.separatorText: Missing required property: separatorText
   $.general.configuration: Missing required property: configuration
   Missing keys (18): general.sensors, general.notConfigured...
   Extra keys (0): none

📊 Summary:
✅ Valid files: 1
❌ Invalid files: 9
```

**Key Information:**
- **Missing required property** - Translation key is missing from the locale
- **Additional property not allowed** - Extra key that doesn't exist in English locale
- **Missing keys** - Summary of missing translations
- **Extra keys** - Keys that should be removed

### Comparison Output

```bash
📊 Locale Completion Statistics
Locale | Total Keys | Present | Missing | Extra | Complete %
-------+------------+---------+---------+-------+-----------
es     | 587        | 587     | 18      | 0     | 97.0%     
fr     | 569        | 566     | 39      | 3     | 93.6%     
```

**Statistics Explained:**
- **Total Keys** - Number of translation keys in this locale
- **Present** - Keys that match the English locale structure  
- **Missing** - Required keys missing from this locale
- **Extra** - Keys that don't exist in the English locale
- **Complete %** - Percentage of English locale keys present

## 🔧 How It Works

### 1. Schema Generation

The system uses the **English locale** (`en.json`) as the master reference:

```javascript
// Generated schema enforces:
{
  "type": "object",
  "properties": {
    "general": {
      "type": "object", 
      "properties": {
        "configuration": { "type": "string", "minLength": 1 }
      },
      "required": ["configuration"],
      "additionalProperties": false
    }
  },
  "required": ["general"],
  "additionalProperties": false
}
```

**Schema Rules:**
- All keys from English locale are **required**
- No **additional properties** allowed (prevents extra keys)
- All values must be **non-empty strings**
- **Nested structure** must match exactly

### 2. Validation Process

1. Load generated JSON schema
2. Parse each locale file  
3. Validate against schema using JSON Schema validation
4. Report detailed errors with exact paths
5. Compare keys with English locale for completeness

### 3. Error Detection

**Common Issues Detected:**
- ❌ Missing translation keys
- ❌ Extra keys not in English locale  
- ❌ Empty string values
- ❌ Incorrect nesting structure
- ❌ Invalid JSON syntax

## 🏗️ Project Structure

```
CeraUI/
├── apps/frontend/src/locale/          # Locale files
│   ├── en.json                       # Master reference  
│   ├── es.json                       # Spanish translations
│   ├── locale.schema.json            # JSON Schema (co-located)
│   └── ...                           # Other languages
└── scripts/                          # Validation scripts
    ├── generate-locale-schema.js     # Schema generator
    ├── validate-locales.js          # Validator
    ├── compare-locales.js           # Comparator
    └── add-schema-references.js     # Schema reference setup
```

## 🚨 Current Status (Example)

Based on recent validation:

| Locale | Completeness | Status | Priority |
|--------|-------------|--------|----------|
| 🇺🇸 English | 100.0% | ✅ Master | - |
| 🇪🇸 Spanish | 97.0% | 🟡 Good | Low |
| 🇩🇪 German | 93.7% | 🟡 Good | Low | 
| 🇫🇷 French | 93.6% | 🟡 Good | Medium |
| 🇧🇷 Portuguese | 90.1% | 🟠 Needs Work | Medium |
| 🇦🇷 Arabic | 86.8% | 🔴 Incomplete | High |
| 🇯🇵 Japanese | 86.8% | 🔴 Incomplete | High |

## 💡 Best Practices

### For Developers

1. **Always run validation** before committing locale changes:
   ```bash
   pnpm i18n:check
   ```

2. **Check specific locales** when working on translations:
   ```bash
   pnpm i18n:compare --locale=es
   ```

3. **Add new keys to English first**, then run schema generation:
   ```bash
   # 1. Add key to apps/frontend/src/locale/en.json
   # 2. Regenerate schema
   pnpm i18n:schema
   # 3. Validate all locales
   pnpm i18n:validate
   ```

### For Translators

1. **Use comparison tool** to see missing translations:
   ```bash
   pnpm i18n:compare --locale=your-language
   ```

2. **Focus on missing sections** shown in the analysis
3. **Remove extra keys** that don't exist in English
4. **Validate your changes** before submitting:
   ```bash
   pnpm i18n:validate --file=your-language.json
   ```

## 🔄 CI Integration

Add to your CI workflow:

```yaml
- name: Validate Locale Files  
  run: pnpm i18n:check
```

This ensures all locale files remain consistent across deployments.

## 🐛 Troubleshooting

### Common Errors

**"Missing required property"**
- Add the missing key to your locale file
- Copy structure from `en.json`

**"Additional property not allowed"**
- Remove the extra key from your locale file  
- Check if key was renamed/removed in English locale

**"String too short"**
- Replace empty strings with actual translations
- Use placeholder text if translation pending

### Getting Help

1. Run detailed validation: `pnpm i18n:validate --file=your-file.json`
2. Compare with master: `pnpm i18n:compare --locale=your-locale`
3. Check English locale structure in `apps/frontend/src/locale/en.json`

## 📈 Statistics

The validation system tracks:
- **21 top-level sections** (general, auth, settings, etc.)
- **~605 total translation keys** across all sections  
- **10 supported languages** currently
- **Nested depth** up to 4 levels in some sections

---

*This validation system ensures translation consistency and prevents missing localizations in production.*