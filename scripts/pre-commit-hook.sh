#!/bin/bash

# CeraUI i18n Pre-commit Hook
# Validates i18n structure before allowing commits

echo "🔍 Running i18n validation..."

# Check if we're in the project root
if [ ! -f "package.json" ]; then
    echo "❌ Please run from project root"
    exit 1
fi

# Check if locale files have been modified
if git diff --cached --name-only | grep -q "src/locale/"; then
    echo "📝 Locale files modified, running validation..."
    
    # Run i18n validation
    npm run i18n:validate
    
    if [ $? -ne 0 ]; then
        echo "❌ i18n validation failed. Please fix issues before committing."
        echo "💡 Run 'npm run i18n:fix' to auto-fix some issues"
        exit 1
    fi
    
    echo "✅ i18n validation passed!"
fi

echo "✅ Pre-commit checks passed!"
exit 0