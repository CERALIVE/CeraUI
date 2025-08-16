# DevTools Tab Documentation

> **⚠️ DEVELOPMENT ONLY**  
> The DevTools tab is **ONLY available in development mode** (`BUILD_INFO.IS_DEV = true`). It is automatically excluded from production builds and will not appear in the navigation when running in production.

## Overview

The DevTools tab provides a comprehensive suite of development utilities and debugging tools for CeraUI developers. This tab is specifically designed to aid in development, testing, and debugging processes during the development lifecycle.

## 🔒 Availability

**Development Mode Only**: This tab is conditionally added to the navigation based on the build environment:

```typescript
// From src/lib/config/index.ts
export const navElements: NavElements = {
  ...baseNavElements,
  ...(BUILD_INFO.IS_DEV
    ? {
        devtools: { label: 'devtools', component: DevTools },
      }
    : {}),
};
```

- ✅ **Development builds**: DevTools tab visible and fully functional
- ❌ **Production builds**: DevTools tab completely excluded from navigation

## Features

### 🛠️ Development Environment Status

The DevTools tab displays real-time information about the current development environment:

- **Development Mode Indicator**: Shows current build mode (development/production)
- **Status Badge**: Animated indicator showing active development status
- **Environment Variables**: Display of current build configuration

### 🔧 Component Testing Tools

#### Demo Overlay Trigger
- **Purpose**: Test overlay components and their behavior
- **Usage**: Click to trigger demo overlays and test their functionality
- **Testing**: Verify overlay positioning, animations, and user interactions

#### Toast Notification Tester
- **Purpose**: Test toast notification system
- **Features**: 
  - Test different toast types (success, error, warning, info)
  - Verify toast positioning and timing
  - Test toast queue management
- **Usage**: Click various buttons to trigger different toast notifications

### 📊 System Information

Real-time system and browser information display:

- **Browser Information**: User agent, version, and capabilities
- **Device Information**: Screen resolution, device type, and platform
- **Performance Metrics**: Memory usage, connection status
- **Environment Details**: Build version, commit hash, and development flags

### 🐛 Console Testing Tools

Interactive console testing utilities:

#### Console Output Tests
- **Log Test**: Test console.log() functionality with formatted output
- **Warning Test**: Test console.warn() with warning-level messages  
- **Error Test**: Test console.error() with error-level messages
- **Table Test**: Test console.table() with structured data display

#### Test Button Actions```javascript
// Log Test - Outputs formatted log message
console.log('✅ Console log test:', { timestamp: new Date(), level: 'info' });

// Warning Test - Outputs warning message
console.warn('⚠️ Console warning test:', { timestamp: new Date(), level: 'warn' });

// Error Test - Outputs error message  
console.error('❌ Console error test:', { timestamp: new Date(), level: 'error' });

// Table Test - Outputs browser information in table format
console.table({
  browser: navigator.userAgent.split(' ')[0],
  language: navigator.language,
  online: navigator.onLine,
});
```

## Usage Guidelines

### Accessing DevTools

> **📍 IMPORTANT**: You must be running CeraUI in **development mode** to see this tab.

1. **Start development server**: `pnpm run dev`
2. **Navigate to DevTools**: Look for the 🛠️ **DevTools** tab in the main navigation
3. **Immediate access**: All tools are ready to use without additional setup

**If you don't see the DevTools tab**: You're likely running a production build. Switch to development mode to access these tools.

### Testing Workflow

1. **Component Testing**: 
   - Use overlay and toast testers to verify UI component behavior
   - Test different states and edge cases
   - Verify responsive behavior across different screen sizes

2. **Console Debugging**:
   - Use console test buttons to verify logging functionality
   - Check browser developer tools for output verification
   - Test different log levels for proper categorization

3. **System Monitoring**:
   - Monitor system information for performance insights
   - Check environment status for build verification
   - Verify browser compatibility and feature support### Development Best Practices

#### When to Use DevTools

- **During Component Development**: Test new components before integration
- **Debugging Sessions**: Use console tools to track down issues
- **Performance Testing**: Monitor system information for bottlenecks
- **UI/UX Validation**: Test toast notifications and overlays

#### Safety Considerations

- **Development Only**: DevTools tab is automatically hidden in production builds
- **No Data Persistence**: All testing data is temporary and not stored
- **Browser Console**: Always check browser developer tools alongside DevTools testing

## Technical Implementation

### Technology Stack

- **Svelte 5**: Built using modern Svelte with runes mode
- **Lucide Icons**: Uses Wrench and Bug icons for visual consistency
- **TailwindCSS**: Styled with Tailwind for responsive design
- **TypeScript**: Full type safety throughout the component

### Integration Points

#### Environment Detection
```typescript
const isDev = BUILD_INFO.IS_DEV;
```

#### Internationalization
All text strings are fully internationalized using svelte-i18n:
- `devtools.title` - Main page title
- `devtools.description` - Page description
- `devtools.developmentMode` - Environment status labels
- And more...#### Build Integration
The DevTools tab automatically detects:
- Build mode (development/production)
- Version information from BUILD_INFO
- Environment configuration

## Troubleshooting

### Common Issues

1. **🚨 DevTools Tab Not Visible** (Most Common Issue)
   
   > **This is the #1 issue**: DevTools is **ONLY** available in development mode!
   
   **Solution**:
   - ✅ Run `pnpm run dev` (development server)
   - ❌ NOT `pnpm run build` + `pnpm run preview` (production build)
   - ❌ NOT deployed/production environments
   
   **Quick Check**: Look for `BUILD_INFO.IS_DEV = true` in your environment

2. **Console Tests Not Working**
   - Open browser developer tools console
   - Check for JavaScript errors
   - Verify browser console permissions

3. **Toast Tests Not Appearing**
   - Ensure toast system is properly initialized
   - Check for CSS conflicts
   - Verify toast container positioning

### Debug Information

When reporting issues, include:
- Browser type and version (from System Info)
- Development environment details
- Console error messages
- Steps to reproduce the issue

## Security Notes

- **Development Only**: DevTools functionality is automatically disabled in production
- **No External Calls**: All testing is performed locally
- **No Data Collection**: No user data is collected or transmitted through DevTools
- **Safe Testing**: All test functions are non-destructive and safe to use

---

> **🔐 FINAL REMINDER**  
> **DevTools is DEVELOPMENT-ONLY**: This entire tab and all its functionality are automatically removed from production builds. You will never see DevTools in:
> - Production deployments
> - Built applications (`pnpm run build`)
> - Preview mode (`pnpm run preview`)
> 
> **To access DevTools**: Always use `pnpm run dev`

*This documentation is for development purposes only. The DevTools tab and its functionality are not available in production builds.*