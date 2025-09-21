#!/bin/bash
# Shared build functions for optimized artifact caching
# This eliminates build redundancy by reusing compatible artifacts

set -e

# Configuration
CACHE_DIR=".build-cache"
FRONTEND_CACHE="$CACHE_DIR/frontend"
BACKEND_CACHE="$CACHE_DIR/backend"

# Ensure cache directories exist
mkdir -p "$CACHE_DIR" "$FRONTEND_CACHE"

# Get current git state for cache validation
get_git_hash() {
    git rev-parse HEAD 2>/dev/null || echo "unknown"
}

get_frontend_hash() {
    # Hash of frontend-specific files to detect changes
    find apps/frontend/src -name "*.svelte" -o -name "*.ts" -o -name "*.js" -o -name "*.css" | sort | xargs cat | sha256sum | cut -d' ' -f1
}

get_backend_hash() {
    # Hash of backend-specific files
    find apps/backend/src -name "*.ts" -o -name "*.js" | sort | xargs cat | sha256sum | cut -d' ' -f1
}

# Check if frontend cache is valid
is_frontend_cache_valid() {
    if [ ! -f "$FRONTEND_CACHE/hash.txt" ] || [ ! -d "$FRONTEND_CACHE/public" ]; then
        return 1
    fi

    local cached_hash=$(cat "$FRONTEND_CACHE/hash.txt")
    local current_hash=$(get_frontend_hash)

    [ "$cached_hash" = "$current_hash" ]
}

# Check if backend cache is valid for specific architecture
is_backend_cache_valid() {
    local arch=$1
    local cache_path="$BACKEND_CACHE/$arch"

    if [ ! -f "$cache_path/hash.txt" ] || [ ! -f "$cache_path/belaUI" ]; then
        return 1
    fi

    local cached_hash=$(cat "$cache_path/hash.txt")
    local current_hash=$(get_backend_hash)

    [ "$cached_hash" = "$current_hash" ]
}

# Build frontend only (architecture independent)
build_frontend_only() {
    echo "🎨 Building frontend (architecture independent)..."

    if is_frontend_cache_valid; then
        echo "✅ Frontend cache valid - reusing existing build"
        cp -r "$FRONTEND_CACHE/public" dist/
        return 0
    fi

    echo "🔄 Frontend changes detected - rebuilding..."

    # Build frontend
    cd apps/frontend
    VITE_BRAND=CERALIVE npm run build
    cd ../..

    # Cache the result
    rm -rf "$FRONTEND_CACHE/public"
    cp -r dist/public "$FRONTEND_CACHE/"
    get_frontend_hash > "$FRONTEND_CACHE/hash.txt"

    echo "✅ Frontend built and cached"
}

# Build backend only for specific architecture
build_backend_only() {
    local arch=${1:-arm64}
    echo "🔧 Building backend for $arch architecture..."

    local cache_path="$BACKEND_CACHE/$arch"
    mkdir -p "$cache_path"

    if is_backend_cache_valid "$arch"; then
        echo "✅ Backend cache valid for $arch - reusing existing build"
        cp "$cache_path/belaUI" dist/
        cp -r "$cache_path/deployment" dist/ 2>/dev/null || true
        return 0
    fi

    echo "🔄 Backend changes detected for $arch - rebuilding..."

    # Build backend for specific architecture
    BUILD_ARCH=$arch pnpm --filter backend run build:backend-only

    # Copy deployment files
    cp -r ./deployment/* ./dist/ 2>/dev/null || true

    # Cache the result
    cp dist/belaUI "$cache_path/"
    cp -r dist/deployment "$cache_path/" 2>/dev/null || true
    get_backend_hash > "$cache_path/hash.txt"

    echo "✅ Backend built and cached for $arch"
}

# Smart build function that uses caching
smart_build() {
    local arch=${BUILD_ARCH:-arm64}
    echo "🚀 Smart build for $arch architecture using artifact caching"

    # Clean dist directory
    rm -rf dist
    mkdir -p dist

    # Build components separately with caching
    build_backend_only "$arch"
    build_frontend_only

    echo "✅ Smart build completed for $arch"
}

# Clean all caches
clean_cache() {
    echo "🧹 Cleaning build cache..."
    rm -rf "$CACHE_DIR"
    echo "✅ Build cache cleaned"
}

# Show cache status
cache_status() {
    echo "📊 Build Cache Status:"
    echo

    if [ -d "$CACHE_DIR" ]; then
        echo "Cache directory: $(du -sh $CACHE_DIR | cut -f1)"

        if [ -d "$FRONTEND_CACHE" ]; then
            if is_frontend_cache_valid; then
                echo "✅ Frontend cache: VALID ($(du -sh $FRONTEND_CACHE | cut -f1))"
            else
                echo "❌ Frontend cache: INVALID"
            fi
        else
            echo "❌ Frontend cache: NOT FOUND"
        fi

        for arch in arm64 amd64; do
            if [ -d "$BACKEND_CACHE/$arch" ]; then
                if is_backend_cache_valid "$arch"; then
                    echo "✅ Backend cache ($arch): VALID ($(du -sh $BACKEND_CACHE/$arch | cut -f1))"
                else
                    echo "❌ Backend cache ($arch): INVALID"
                fi
            else
                echo "❌ Backend cache ($arch): NOT FOUND"
            fi
        done
    else
        echo "❌ No cache directory found"
    fi
}

# Export functions for use in other scripts
export -f get_git_hash get_frontend_hash get_backend_hash
export -f is_frontend_cache_valid is_backend_cache_valid
export -f build_frontend_only build_backend_only smart_build
export -f clean_cache cache_status
