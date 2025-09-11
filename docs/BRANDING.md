# Conditional Branding System

The CeraUI project supports conditional branding to compile different versions of the application for different hardware brands.

## Supported Brands

- **CERALIVE** (Main brand, default)
- **BELABOX** (Secondary frontend-only brand)

## Brand Configuration

### Environment Variable

The branding is controlled by the `VITE_BRAND` environment variable:

```bash
# Build for CERALIVE (default)
VITE_BRAND=CERALIVE pnpm build

# Build for BELABOX
VITE_BRAND=BELABOX pnpm build
```

### Build Scripts

The build system defaults to CERALIVE (main brand) with a secondary script for BELABOX:

```bash
# Development
pnpm dev             # Run development server with CERALIVE branding (default)
pnpm dev:belabox     # Run development server with BELABOX branding

# Production builds
pnpm build           # Build for CERALIVE (main brand, default)
pnpm build:belabox   # Build for BELABOX (secondary brand)
```

## How It Works

### 1. Frontend Configuration

The branding system is centralized in `apps/frontend/src/lib/config/branding.ts`:

```typescript
export const CURRENT_BRAND: BrandName =
  (import.meta.env.VITE_BRAND as BrandName) || "CERALIVE";

export const BRAND_CONFIG = brandConfigs[CURRENT_BRAND];
```

### 2. Build-time Replacement

During the build process:

- Vite injects the brand configuration as `__BRAND_CONFIG__`
- HTML templates are dynamically updated with brand-specific content
- PWA manifests are generated with the correct brand names

### 3. i18n Integration

The internationalization system supports dynamic branding through placeholder replacement:

```typescript
// In translation files
placeholderName: brandTranslation("{{deviceName}}"),
cloudRemoteKey: brandTranslation("{{cloudService}} Remote Key"),
description: brandTranslation("CeraUI needs an internet connection to manage your {{deviceName}} device."),
```

Available placeholders:

- `{{deviceName}}` - Device name (CERALIVE/BELABOX)
- `{{deviceNameLower}}` - Lowercase device name
- `{{siteName}}` - Full site name with copyright
- `{{cloudService}}` - Cloud service name
- `{{logName}}` - Log file name
- `{{organizationName}}` - Organization name

### 4. Component Integration

Components can access brand configuration through:

```typescript
import { BRAND_CONFIG, deviceName, siteName } from "$lib/config/branding";

// Use in components
console.log(BRAND_CONFIG.deviceName); // "CERALIVE" or "BELABOX"
```

## File Structure

```
apps/frontend/src/lib/config/
├── branding.ts          # Main branding configuration
└── index.ts            # Re-exports for backward compatibility

packages/i18n/src/
├── branding.ts          # i18n branding helpers
└── en/index.ts         # Updated with brand placeholders

apps/frontend/
├── index.html          # Dynamic HTML updates
├── pwa.config.ts       # PWA branding
└── vite.config.ts      # Build-time brand injection
```

## Legacy Compatibility

The system maintains backward compatibility:

- Existing imports from `$lib/config` continue to work
- The `getBelaboxLog` function is aliased to `getDeviceLog`
- All hardcoded brand references are replaced with dynamic ones

## Adding New Brands

To add a new brand:

1. Update the `BrandName` type in `branding.ts`
2. Add the brand configuration to `brandConfigs`
3. Update build scripts in `package.json`
4. Test all components and translations

## Best Practices

1. **Use placeholders in translations** instead of hardcoded brand names
2. **Import from `$lib/config/branding`** for brand-specific logic
3. **Test both brands** during development
4. **Use the provided build scripts** for consistent builds

## Examples

### Development

```bash
# Start development with CERALIVE branding (default)
pnpm dev

# Start development with BELABOX branding
pnpm dev:belabox
```

### Production Deployment

```bash
# Build CERALIVE version (main brand, default)
pnpm build

# Build BELABOX version (secondary brand)
pnpm build:belabox
```

The compiled output will have all brand-specific content correctly replaced throughout the application, including HTML meta tags, PWA manifests, and all translated text.
