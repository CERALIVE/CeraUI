# 🔧 Comprehensive Linting & Formatting Setup

## 📋 Overview

Perfect tool separation for the CeraUI monorepo:

- **Biome**: TypeScript, JavaScript, JSON (backend & frontend config files)
- **ESLint + Prettier**: Svelte files only (frontend components)

## 🎯 Tool Assignments by File Type

### Backend Files (`apps/backend/`)

- **Formatter**: Biome
- **Linter**: Biome
- **Runtime**: Bun globals enabled
- **Files**: `*.ts`, `*.js`, `*.json`, `*.jsonc`

### Frontend Config Files (`apps/frontend/`)

- **Formatter**: Biome
- **Linter**: Biome
- **Runtime**: Node.js globals enabled
- **Files**: `*.ts`, `*.js`, `*.json`, `*.jsonc`, `vite.config.ts`, `tailwind.config.ts`, etc.

### Frontend Svelte Files (`apps/frontend/`)

- **Formatter**: ESLint + Prettier plugin (unified workflow)
- **Linter**: ESLint (Svelte 5 runes optimized)
- **Biome**: Explicitly disabled
- **Files**: `*.svelte`

### Root Config Files

- **Formatter**: Biome
- **Linter**: Biome
- **Files**: `package.json`, `biome.json`, `tsconfig.json`, etc.

## 🚀 Scripts Available

### Root Level (`pnpm <script>`)

```bash
pnpm format         # Format all files with correct tools
pnpm format:check   # Check formatting without fixing
pnpm lint           # Lint all files with correct tools
pnpm lint:fix       # Fix all auto-fixable issues
pnpm fix            # Format + lint fix everything
pnpm quality        # Check everything (format + lint + typecheck)
pnpm quality:fix    # Fix everything (format + lint + typecheck)
```

### Per-App Scripts

```bash
pnpm --filter backend run lint     # Backend Biome linting
pnpm --filter frontend run lint    # Frontend ESLint (Svelte files only)
pnpm --filter backend run format:check    # Backend Biome format checking
pnpm --filter frontend run format:check   # Frontend Biome format checking (TS/JS/config files)
pnpm --filter backend run fix      # Backend Biome fix
pnpm --filter frontend run fix     # Frontend ESLint + Prettier plugin fix
```

## ⚙️ Configuration Files

### Root Configuration

- `biome.json` - Shared Biome rules and formatting (excludes .svelte, .vscode, .cursor)
- `.vscode/settings.json` - Perfect tool separation by file type and path
- `.vscode/extensions.json` - Recommended extensions (Biome, Svelte, Tailwind)
- `.cursor/settings.json` - Cursor-specific debugging settings

### Backend Configuration

- `apps/backend/biome.json` - Extends root + Bun globals

### Frontend Configuration

- `apps/frontend/biome.json` - Extends root + Node.js globals (excludes .svelte)
- `apps/frontend/eslint.config.mjs` - Svelte 5 runes optimized ESLint + Prettier plugin integration
- `apps/frontend/.prettierrc` - Prettier config for ESLint plugin (Svelte + Tailwind)
- `apps/frontend/package.json` - Simplified scripts: no separate format commands (lint handles everything)

## 🎨 Formatting Standards

- **Indentation**: Tabs (width: 2)
- **Line Endings**: LF (Linux style)
- **Line Width**: 100 characters
- **Quotes**: Single quotes
- **Semicolons**: Always
- **Trailing Commas**: ES5 compatible

## ✅ VS Code/Cursor Integration

- **Auto-format on save**: Enabled for all file types
- **Auto-fix on save**: Enabled for all file types
- **Default formatters**: Assigned per file type and path
- **Biome disabled**: Explicitly for Svelte files
- **ESLint enabled**: Only for Svelte files
- **Path-based overrides**: Ensure correct tool usage per location

## 🔍 Svelte 5 Runes Support

- **ESLint globals**: `$state`, `$derived`, `$effect`, `$props`, `$bindable`, `$inspect`, `$host`
- **Migration rules**: Disabled deprecated `$:` reactive statements
- **Event handlers**: Modern `onevent` syntax enforced
- **Accessibility**: Reasonable a11y rules without being overly strict

## 🚫 What's Excluded

- **Svelte files**: Excluded from all Biome configurations
- **Node modules**: Excluded from all linting and formatting
- **Build outputs**: `dist/`, `build/`, `.svelte-kit/` excluded
- **Generated files**: `*.d.ts` files excluded from most rules

## 🧪 Testing the Setup

```bash
# Test formatting
pnpm format:check

# Test linting
pnpm lint

# Test everything
pnpm quality

# Fix everything
pnpm quality:fix
```

## 📁 File Structure

```
CeraUI/
├── biome.json                     # Root Biome config
├── .vscode/settings.json          # Perfect tool separation
├── .cursor/settings.json          # Cursor debugging
├── apps/
│   ├── backend/
│   │   ├── biome.json            # Backend Biome (Bun globals)
│   │   └── src/**/*.{ts,js}      # → Biome formatted/linted
│   └── frontend/
│       ├── biome.json            # Frontend Biome (Node globals)
│       ├── eslint.config.mjs     # Svelte ESLint + Prettier plugin
│       ├── .prettierrc           # Prettier config for ESLint plugin
│       ├── src/**/*.{ts,js}      # → Biome formatted/linted
│       └── src/**/*.svelte       # → ESLint + Prettier plugin (unified)
└── package.json                  # → Biome formatted
```

---

_This setup ensures zero conflicts between tools while maintaining consistent formatting and comprehensive linting across the entire monorepo._
