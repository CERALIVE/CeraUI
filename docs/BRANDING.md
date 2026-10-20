# CeraLive Branding

CeraUI is the web interface for the **CeraLive** streaming encoder platform.

## Brand Configuration

The branding is configured in the following files:

| File | Purpose |
|------|---------|
| `apps/frontend/src/lib/config/branding.ts` | Frontend brand constants |
| `apps/frontend/vite.config.ts` | Build-time brand injection |
| `apps/frontend/pwa.config.ts` | PWA manifest branding |
| `packages/i18n/src/branding.ts` | i18n brand placeholders |

## Build Scripts

```bash
# Development
bun run dev           # Start development server

# Production builds
bun run build         # Build for production
bun run build:backend # Build backend only
bun run build:frontend # Build frontend only
```

## Logo and icon assets

The shared logo, favicons and PWA icons [EXISTS] are vendored from the private
`CERALIVE/ceralive-brand` release `v2026.10.0`. The repository-root
`brand-assets.lock.json` records release provenance and SHA-256 hashes for every
vendored file, including the standalone sync script and integrity verifier.
CI checks the committed bytes offline; it never needs access to the brand repo.
The integrity verifier keeps its upstream single-quote, 100-column formatting
through a file-scoped Biome override; the sync script declares its Bun runtime
global in the root Biome configuration. Both remain linted without rewriting
the release bytes.

Maintainers with access refresh the assets from this repository's root:

```bash
bun scripts/sync-brand-assets.ts --tag v2026.10.0
```

Do not hand-edit vendored files. `BRAND-ASSETS-NOTICE.md` lists them and records
that the CeraLive brand assets are not covered by this repository's license;
all rights are reserved.

The shared `Logo.svelte` serves the small light mark by default, the small dark
mark under `html.dark`, and the monochrome ink mark under
`html[data-display='eink']`, overriding either color theme. Its images are
decorative because the header button or sign-in heading already names the brand.
The PWA manifest is generated only by VitePWA, with separate regular and
maskable icons. `/favicon.ico` remains available at its stable path because the
offline-state store uses it as its origin-recovery probe.

## i18n Integration

The internationalization system supports dynamic branding through placeholder replacement:

```typescript
// In translation files
placeholderName: brandTranslation("{{deviceName}}"),
cloudRemoteKey: brandTranslation("{{cloudService}} Remote Key"),
description: brandTranslation("CeraUI needs an internet connection to manage your {{deviceName}} device."),
```

### Available Placeholders

| Placeholder | Value |
|-------------|-------|
| `{{deviceName}}` | CeraLive |
| `{{deviceNameLower}}` | ceralive |
| `{{siteName}}` | CeraUI for CeraLive© |
| `{{cloudService}}` | CeraLive Cloud |
| `{{logName}}` | CeraLive Log |
| `{{organizationName}}` | CeraLive |

## Component Integration

Components can access brand configuration through:

```typescript
import { BRAND_CONFIG, deviceName, siteName } from "$lib/config/branding";

// Use in components
console.log(BRAND_CONFIG.deviceName); // "CeraLive"
console.log(deviceName);              // "CeraLive"
console.log(siteName);                // "CeraUI for CeraLive©"
```

## File Structure

```
apps/frontend/src/lib/config/
├── branding.ts          # Main branding configuration
└── index.ts             # Re-exports

packages/i18n/src/
├── branding.ts          # i18n branding helpers
└── en/index.ts          # Translations with brand placeholders

apps/frontend/
├── index.html           # HTML with brand meta tags
├── pwa.config.ts        # PWA branding
└── vite.config.ts       # Build-time brand injection
```

## Multi-Provider Cloud Support

CeraUI supports multiple cloud providers for remote management. Users can select from predefined providers or configure a custom provider.

### Predefined Providers

| Provider | Host | Cloud URL |
|----------|------|-----------|
| CeraLive Cloud | `remote.ceralive.net` | `https://cloud.ceralive.net` |
| BELABOX Cloud | `remote.belabox.net` | `https://cloud.belabox.net` |

### Custom Provider Configuration

Users can configure a custom cloud provider with the following options:

- **Provider Name**: Display name for the provider
- **WebSocket Host**: The hostname for the WebSocket connection (e.g., `remote.example.com`)
- **Secure Connection**: Whether to use `wss://` (secure) or `ws://` protocol

### Configuration Storage

Provider configuration is stored in `config.json`:

```json
{
  "remote_key": "your-remote-key",
  "remote_provider": "ceralive",
  "custom_provider": {
    "name": "My Provider",
    "host": "remote.example.com",
    "path": "/ws/remote",
    "secure": true
  }
}
```

### Adding New Predefined Providers

To add a new predefined provider, update `packages/rpc/src/schemas/cloud-provider.schema.ts`:

```typescript
export const CLOUD_PROVIDERS: CloudProviderEndpoint[] = [
  // ... existing providers
  {
    id: 'newprovider',
    name: 'New Provider Cloud',
    host: 'remote.newprovider.com',
    path: '/ws/remote',
    secure: true,
    cloudUrl: 'https://cloud.newprovider.com',
  },
];
```

Also update the `providerSelectionSchema` to include the new provider ID.

## Best Practices

1. **Use placeholders in translations** instead of hardcoded brand names
2. **Import from `$lib/config/branding`** for brand-specific logic
3. **Use the provided build scripts** for consistent builds
4. **Use predefined providers** when possible for consistency
