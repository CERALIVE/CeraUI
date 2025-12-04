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

# Common build configuration functions
get_version() {
    echo "${BUILD_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/v//' || echo "1.0.0")}"
}

get_commit() {
    git rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_build_date() {
    date -u +"%Y%m%d_%H%M%S"
}

get_architecture() {
    if [ -n "$BUILD_ARCH" ]; then
        echo "$BUILD_ARCH"
    else
        # Auto-detect architecture
        case "$(uname -m)" in
            x86_64) echo "amd64" ;;
            aarch64) echo "arm64" ;;
            *)
                echo "⚠️  Unsupported architecture: $(uname -m)" >&2
                echo "Supported architectures: amd64 (x86_64), arm64 (aarch64)" >&2
                return 1
                ;;
        esac
    fi
}

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

    if [ ! -f "$cache_path/hash.txt" ] || [ ! -f "$cache_path/ceralive" ]; then
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
        cp "$cache_path/ceralive" dist/
        cp -r "$cache_path/deployment" dist/ 2>/dev/null || true
        return 0
    fi

    echo "🔄 Backend changes detected for $arch - rebuilding..."

    # Build backend for specific architecture
    BUILD_ARCH=$arch pnpm --filter backend run build:backend-only

    # Copy deployment files
    cp -r ./deployment/* ./dist/ 2>/dev/null || true

    # Cache the result
    cp dist/ceralive "$cache_path/"
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

# Common logging and error handling functions
log_info() {
    echo "ℹ️  $1"
}

log_success() {
    echo "✅ $1"
}

log_warning() {
    echo "⚠️  $1" >&2
}

log_error() {
    echo "❌ $1" >&2
}

log_step() {
    echo "🔧 $1"
}

# Validate required tools
validate_tools() {
    local tools=("$@")
    local missing=()

    for tool in "${tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            missing+=("$tool")
        fi
    done

    if [ ${#missing[@]} -ne 0 ]; then
        log_error "Missing required tools: ${missing[*]}"
        return 1
    fi
}

# Create directory with logging
ensure_dir() {
    local dir="$1"
    if [ ! -d "$dir" ]; then
        log_step "Creating directory: $dir"
        mkdir -p "$dir"
    fi
}

# Performance monitoring functions
PERF_DIR="$CACHE_DIR/performance"
PERF_LOG="$PERF_DIR/build-history.json"

# Initialize performance monitoring
init_performance_monitoring() {
    ensure_dir "$PERF_DIR"

    if [ ! -f "$PERF_LOG" ]; then
        echo '{"builds": [], "baselines": {}}' > "$PERF_LOG"
    fi
}

# Start timing a build operation
start_timer() {
    local operation="$1"
    ensure_dir "$PERF_DIR"
    echo "$(date +%s)" > "$PERF_DIR/${operation}_start.tmp"
}

# End timing and record performance data
end_timer() {
    local operation="$1"
    local start_file="$PERF_DIR/${operation}_start.tmp"

    if [ ! -f "$start_file" ]; then
        log_warning "No start time found for operation: $operation"
        return 1
    fi

    local start_time=$(cat "$start_file")
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    rm -f "$start_file"
    echo "$duration"
}

# Record build performance metrics
record_build_metrics() {
    local operation="$1"
    local duration="$2"
    local architecture="$3"
    local extra_data="$4"

    init_performance_monitoring

    # Get bundle sizes if available
    local bundle_sizes=""
    if [ -d "dist/public/assets" ]; then
        bundle_sizes=$(find dist/public/assets -name "*.js" -exec du -b {} \; | awk '{sum+=$1} END {print sum}')
    fi

    # Create performance record
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local commit=$(get_commit)
    local version=$(get_version)

    # Add record to performance log (simplified approach)
    local temp_log="$PERF_DIR/temp.json"
    cat "$PERF_LOG" | jq --arg op "$operation" --arg dur "$duration" --arg arch "$architecture" \
        --arg ts "$timestamp" --arg commit "$commit" --arg version "$version" --arg bundle "$bundle_sizes" \
        '.builds += [{
            "timestamp": $ts,
            "operation": $op,
            "duration": ($dur | tonumber),
            "architecture": $arch,
            "commit": $commit,
            "version": $version,
            "bundleSize": ($bundle | tonumber // 0),
            "cacheHit": false
        }]' > "$temp_log" 2>/dev/null && mv "$temp_log" "$PERF_LOG" || {
        # Fallback if jq is not available
        log_info "Performance recorded: $operation took ${duration}s"
    }
}

# Show performance statistics
show_performance_stats() {
    init_performance_monitoring

    if [ ! -s "$PERF_LOG" ]; then
        log_info "No performance data available yet"
        return
    fi

    log_info "📊 Build Performance Statistics"
    echo

    # Try to use jq for nice formatting, fallback to basic info
    if command -v jq &> /dev/null; then
        local total_builds=$(cat "$PERF_LOG" | jq '.builds | length')
        log_info "Total builds recorded: $total_builds"

        if [ "$total_builds" -gt 0 ]; then
            local avg_duration=$(cat "$PERF_LOG" | jq '.builds | map(.duration) | add / length')
            log_info "Average build time: ${avg_duration}s"

            local last_build=$(cat "$PERF_LOG" | jq -r '.builds[-1] | "Last: \(.operation) (\(.architecture)) - \(.duration)s on \(.timestamp)"')
            log_info "$last_build"
        fi
    else
        log_info "Performance log exists ($(wc -l < "$PERF_LOG") entries)"
        log_info "Install 'jq' for detailed performance statistics"
    fi
}

# Check for performance regressions
check_regression() {
    local current_duration="$1"
    local operation="$2"
    local threshold="20"  # 20% regression threshold

    init_performance_monitoring

    if command -v jq &> /dev/null && [ -s "$PERF_LOG" ]; then
        # Get average of last 5 builds for this operation
        local avg_recent=$(cat "$PERF_LOG" | jq --arg op "$operation" \
            '[.builds[] | select(.operation == $op)][-5:] | map(.duration) | add / length' 2>/dev/null)

        if [ "$avg_recent" != "null" ] && [ -n "$avg_recent" ]; then
            local regression_check=$(echo "$current_duration $avg_recent $threshold" | awk '{
                if ($1 > $2 * (1 + $3/100)) {
                    print "true"
                } else {
                    print "false"
                }
            }')

            if [ "$regression_check" = "true" ]; then
                log_warning "⚠️  PERFORMANCE REGRESSION DETECTED!"
                log_warning "Current: ${current_duration}s, Recent average: ${avg_recent}s"
                log_warning "This is >$threshold% slower than recent builds"
                return 1
            fi
        fi
    fi

    return 0
}

# Enhanced smart build with performance monitoring
smart_build_monitored() {
    local arch=${BUILD_ARCH:-arm64}
    log_info "🚀 Smart build for $arch architecture with performance monitoring"

    start_timer "smart_build"

    # Call original smart build
    smart_build

    local duration=$(end_timer "smart_build")
    log_success "Smart build completed in ${duration}s"

    # Record metrics
    record_build_metrics "smart_build" "$duration" "$arch"

    # Check for regressions
    if ! check_regression "$duration" "smart_build"; then
        log_info "Consider investigating what might have caused the slowdown"
    fi

    return 0
}

# Export all functions for use in other scripts
export -f get_version get_commit get_build_date get_architecture
export -f get_git_hash get_frontend_hash get_backend_hash
export -f is_frontend_cache_valid is_backend_cache_valid
export -f build_frontend_only build_backend_only smart_build smart_build_monitored
export -f clean_cache cache_status
export -f log_info log_success log_warning log_error log_step
export -f validate_tools ensure_dir
export -f init_performance_monitoring start_timer end_timer record_build_metrics
export -f show_performance_stats check_regression
