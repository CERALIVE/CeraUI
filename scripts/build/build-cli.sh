#!/bin/bash
# CeraUI Build System CLI - Management interface for the optimized build system

source "$(dirname "$0")/shared-build-functions.sh"

SCRIPT_NAME=$(basename "$0")
SCRIPT_DIR=$(dirname "$0")

# CLI Functions
show_help() {
    cat << EOF
🚀 CeraUI Build System CLI - Optimized Multi-Architecture Build Management

USAGE:
    $SCRIPT_NAME <command> [options]

COMMANDS:
    cache           Show build cache status and statistics
    clean           Clean all cached artifacts
    build           Smart build with caching (default: ARM64)
    build-all       Build for all architectures (ARM64 + AMD64)
    system          Create system distribution archive
    debian          Create Debian package (requires FPM)
    info            Show build environment information
    perf            Show build performance statistics
    help            Show this help message

BUILD OPTIONS:
    --arch <arch>   Specify architecture: arm64, amd64 (default: arm64)
    --version <ver> Specify build version (default: auto-detect from git)
    --clean-first   Clean cache before building

EXAMPLES:
    $SCRIPT_NAME cache                    # Show cache status
    $SCRIPT_NAME build --arch amd64       # Build for AMD64
    $SCRIPT_NAME build-all               # Build for both architectures
    $SCRIPT_NAME system --arch arm64     # Create ARM64 system archive
    $SCRIPT_NAME clean                   # Clean all caches

FEATURES:
    ✅ Smart artifact caching (73% faster builds)
    ✅ Bundle optimization (7 chunks: 50-434KB each)
    ✅ Multi-architecture support (ARM64/AMD64)
    ✅ APT-compatible versioning
    ✅ Consistent logging and error handling

EOF
}

show_info() {
    log_info "CeraUI Build System Information"
    echo
    log_info "Version: $(get_version)"
    log_info "Commit: $(get_commit)"
    log_info "Build Date: $(get_build_date)"
    log_info "Architecture: $(get_architecture)"
    echo
    log_info "Environment:"
    log_info "  Node.js: $(node --version 2>/dev/null || echo 'Not installed')"
    log_info "  pnpm: $(pnpm --version 2>/dev/null || echo 'Not installed')"
    log_info "  Git: $(git --version 2>/dev/null | cut -d' ' -f3 || echo 'Not installed')"
    log_info "  FPM: $(fpm --version 2>/dev/null || echo 'Not installed (Debian packages unavailable)')"
    echo
    log_info "Workspace Status:"
    log_info "  Root node_modules: $(du -sh node_modules 2>/dev/null | cut -f1 || echo 'Not found')"
    log_info "  Frontend deps: $(du -sh apps/frontend/node_modules 2>/dev/null | cut -f1 || echo 'Not found')"
    log_info "  Backend deps: $(du -sh apps/backend/node_modules 2>/dev/null | cut -f1 || echo 'Not found')"
}

run_build() {
    local arch="$1"
    local clean_first="$2"

    if [ "$clean_first" = "true" ]; then
        log_step "Cleaning cache before build"
        clean_cache
    fi

    log_info "Starting monitored smart build for $arch architecture"
    BUILD_ARCH="$arch" smart_build_monitored
}

run_build_all() {
    local clean_first="$1"

    log_info "Building for all architectures (ARM64 + AMD64)"

    run_build "arm64" "$clean_first"
    run_build "amd64" "false"  # Don't clean cache between builds

    log_success "All architectures built successfully!"
    echo
    cache_status
}

run_system_build() {
    local arch="$1"

    log_info "Creating system distribution for $arch"

    if [ ! -f "$SCRIPT_DIR/build-ceraui-system.sh" ]; then
        log_error "System build script not found"
        exit 1
    fi

    BUILD_ARCH="$arch" "$SCRIPT_DIR/build-ceraui-system.sh"
}

run_debian_build() {
    local arch="$1"

    log_info "Creating Debian package for $arch"

    if ! command -v fpm &> /dev/null; then
        log_error "FPM not installed. Cannot create Debian packages."
        log_info "Install with: gem install fpm"
        exit 1
    fi

    BUILD_ARCH="$arch" "$SCRIPT_DIR/build-debian-package.sh"
}

# Parse command line arguments
COMMAND=""
ARCH="arm64"
VERSION=""
CLEAN_FIRST="false"

while [[ $# -gt 0 ]]; do
    case $1 in
        cache|clean|build|build-all|system|debian|info|perf|help)
            COMMAND="$1"
            shift
            ;;
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --version)
            export BUILD_VERSION="$2"
            shift 2
            ;;
        --clean-first)
            CLEAN_FIRST="true"
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Set architecture for all operations
export BUILD_ARCH="$ARCH"

# Execute command
case "$COMMAND" in
    "cache")
        cache_status
        ;;
    "clean")
        clean_cache
        ;;
    "build")
        run_build "$ARCH" "$CLEAN_FIRST"
        ;;
    "build-all")
        run_build_all "$CLEAN_FIRST"
        ;;
    "system")
        run_system_build "$ARCH"
        ;;
    "debian")
        run_debian_build "$ARCH"
        ;;
    "info")
        show_info
        ;;
    "perf")
        show_performance_stats
        ;;
    "help"|"")
        show_help
        ;;
    *)
        log_error "Unknown command: $COMMAND"
        show_help
        exit 1
        ;;
esac
