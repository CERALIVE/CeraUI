# @ceraui/i18n-typebox

TypeScript-first internationalization system with TypeBox schema definition and framework adapters.

## Features

- ✅ **TypeScript-first** - Define schemas with full type safety
- ✅ **Framework-agnostic** - Core utilities work with any framework
- ✅ **Template literals** - Type-safe parameter interpolation
- ✅ **Auto-generation** - JSON schema and framework adapters
- ✅ **Dead code detection** - AST-based usage analysis
- ✅ **IntelliSense** - Full IDE support with autocomplete

## Quick Start

### 1. Define Schema

```typescript
import { defineI18nSchema, TemplateLiteral, Type } from '@ceraui/i18n-typebox'

export const MyI18nSchema = defineI18nSchema({
  auth: Type.Object({
    login: Type.String(),
    welcome: TemplateLiteral('Welcome back, {name}!')
  }),
  errors: Type.Object({
    notFound: Type.String()
  })
})

export type MyI18nKeys = InferI18nSchema<typeof MyI18nSchema>
```

### 2. Generate Framework Adapter

```typescript
import { generateSvelteStore } from '@ceraui/i18n-typebox/svelte'

generateSvelteStore(
  MyI18nSchema, 
  './src/lib/stores/i18n.svelte.ts',
  './types/i18n.js'
)
```

### 3. Use in Components

```svelte
<script>
  import { i18n } from '$lib/stores/i18n.svelte.ts'
</script>

<!-- Regular strings -->
<p>{i18n.t.auth.login()}</p>

<!-- Template literals with parameters -->
<p>{i18n.t.auth.welcome({ name: 'John' })}</p>
```

## Framework Support

- ✅ **Svelte 5** - Runes-based store with full reactivity
- 🔄 **React** - Hooks-based implementation (planned)
- 🔄 **Vue 3** - Composition API (planned)
- 🔄 **Angular** - Signals-based service (planned)

## Architecture

```
Core Schema (TypeBox) → Framework Adapter → Generated Store/Hook/Service
     ↓                       ↓                      ↓
Type-safe definitions → Optimized accessors → Runtime validation
```

## License

MIT