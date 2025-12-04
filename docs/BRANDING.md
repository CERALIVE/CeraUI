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
pnpm dev              # Start development server

# Production builds  
pnpm build            # Build for production
pnpm build:backend    # Build backend only
pnpm build:frontend   # Build frontend only
```

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
| `{{deviceName}}` | CERALIVE |
| `{{deviceNameLower}}` | ceralive |
| `{{siteName}}` | CeraUI for CERALIVE© |
| `{{cloudService}}` | CeraLive Cloud |
| `{{logName}}` | CeraLive Log |
| `{{organizationName}}` | CeraLive |

## Component Integration

Components can access brand configuration through:

```typescript
import { BRAND_CONFIG, deviceName, siteName } from "$lib/config/branding";

// Use in components
console.log(BRAND_CONFIG.deviceName); // "CERALIVE"
console.log(deviceName);              // "CERALIVE"
console.log(siteName);                // "CeraUI for CERALIVE©"
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
