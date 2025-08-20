#!/usr/bin/env bash

# CeraUI Monorepo Installation Script
# 
# This script installs the CeraUI monorepo (frontend + belaUI backend) to a BELABOX device.
# 
# Usage:
#   ./install.sh                             # Local installation from GitHub releases
#   ./install.sh --remote [SSH_TARGET]       # Remote deployment from local dist folder
#   ./install.sh --help                      # Show help

# This script uses strict error handling:
#   - set -e: Exit immediately if any command returns a non-zero status.
#   - set -u: Treat unset variables as errors and exit immediately.
#   - set -o pipefail: Ensure that a pipeline fails if any command in it fails.
set -euo pipefail

# Default values
DEPLOY_MODE="local"
SSH_TARGET=""
BELAUI_PATH="/opt/belaUI"

# GitHub release configuration
RELEASE_TARBALL="ceraui-monorepo.tar.xz"
RELEASE_URL="https://github.com/CERALIVE/CeraUI/releases/latest/download/$RELEASE_TARBALL"

# Local deployment configuration
DIST_PATH="dist"

# show_help displays usage instructions, available options, arguments, environment variables, and example commands for the CeraUI monorepo installation script.
show_help() {
  cat << EOF
CeraUI Monorepo Installation Script

USAGE:
  $0 [OPTIONS] [SSH_TARGET]

OPTIONS:
  --remote, -r        Deploy from local dist folder to remote machine via SSH
  --help, -h          Show this help message

ARGUMENTS:
  SSH_TARGET          SSH target for remote deployment (default: root@belabox.local)
                      Only used with --remote option

EXAMPLES:
  # Local installation from GitHub releases
  $0

  # Remote deployment from local dist folder
  $0 --remote
  $0 --remote root@192.168.1.100
  $0 --remote user@belabox.local

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --remote|-r)
      DEPLOY_MODE="remote"
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    -*)
      echo "Unknown option $1"
      show_help
      exit 1
      ;;
    *)
      if [[ "$DEPLOY_MODE" == "remote" ]]; then
        SSH_TARGET="$1"
      else
        echo "SSH target can only be specified with --remote option"
        show_help
        exit 1
      fi
      shift
      ;;
  esac
done

# Set default SSH target for remote deployment
if [[ "$DEPLOY_MODE" == "remote" && -z "$SSH_TARGET" ]]; then
  SSH_TARGET="root@belabox.local"
fi

# detect_package_manager determines the system's package manager by checking the OS type and available commands, returning 'brew', 'apt', 'pacman', or 'unknown'.
detect_package_manager() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "brew"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v pacman >/dev/null 2>&1; then
    echo "pacman"
  else
    echo "unknown"
  fi
}

# install_if_missing_local installs the specified command using apt-get if it is not already present on the local system.
install_if_missing_local() {
  local cmd=$1
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Installing missing dependency: $cmd"
    sudo apt-get update
    sudo apt-get install -y "$cmd"
  fi
}

# install_if_missing_dev checks if a command exists on the development machine and installs it using the detected package manager if missing.
install_if_missing_dev() {
  local cmd=$1
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Command '$cmd' not found. Installing..."
    local package_manager=$(detect_package_manager)
    case "$package_manager" in
      brew)
        brew install "$cmd"
        ;;
      apt)
        sudo apt-get update && sudo apt-get install -y "$cmd"
        ;;
      pacman)
        sudo pacman -Sy --noconfirm "$cmd"
        ;;
      *)
        echo "Unsupported package manager. Please install '$cmd' manually."
        exit 1
        ;;
    esac
  fi
}

# check_disk_space checks if at least 100MB of disk space is available in /tmp and warns if space is low.
check_disk_space() {
  local required_space_mb=100
  if command -v df >/dev/null 2>&1; then
    local available_space=$(df /tmp | awk 'NR==2 {print $4}')
    # Convert from KB to MB
    available_space=$((available_space / 1024))
    if [[ $available_space -lt $required_space_mb ]]; then
      echo "Warning: Low disk space in /tmp (${available_space}MB available, ${required_space_mb}MB recommended)"
    fi
  fi
}

# execute_cmd runs a shell command either locally or on a remote host via SSH, depending on the deployment mode.
execute_cmd() {
  local cmd="$1"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    ssh "$SSH_TARGET" "$cmd"
  else
    eval "$cmd"
  fi
}

# execute_sudo_cmd executes a command with elevated privileges, either locally using sudo or remotely via SSH, depending on the deployment mode.
execute_sudo_cmd() {
  local cmd="$1"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    ssh "$SSH_TARGET" "$cmd"
  else
    sudo bash -c "$cmd"
  fi
}

# copy_files copies files from a source directory to a destination, using rsync locally or over SSH for remote deployment, and sets ownership to root.
copy_files() {
  local source="$1"
  local dest="$2"
  local exclude_args="$3"
  
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    # Remote deployment from local dist folder
    local rsync_target="${SSH_TARGET}:${dest}"
    echo "Deploying to $rsync_target"
    rsync -rltvz --delete --chown=root:root $exclude_args "${source}/" "$rsync_target"
  else
    # Local installation
    echo "Installing belaUI to $dest"
    sudo rsync -rltz --delete --chown=root:root $exclude_args "${source}/" "$dest"
  fi
}



# main orchestrates the installation or deployment of the CeraUI monorepo (frontend + belaUI backend), handling both local and remote modes, dependency checks, file transfers, and post-install configuration.
main() {
  echo "CeraUI Monorepo Installation Script"
  echo "Mode: $DEPLOY_MODE"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    echo "Target: $SSH_TARGET"
  fi

  echo
  echo "NOTE: This script is designed for Debian/Ubuntu based distributions."
  echo "      All current BELABOX images are based on these distributions."
  echo "      Other Linux distributions may require manual dependency installation."
  echo

  # Check for apt-get availability in local install mode
  if [[ "$DEPLOY_MODE" == "local" ]]; then
    if ! command -v apt-get >/dev/null 2>&1; then
      echo "Error: apt-get not found. This script requires apt-get for dependency installation."
      echo "       Please ensure you are running on a Debian/Ubuntu based distribution."
      exit 1
    fi
  fi

  # Define rsync exclude arguments
  local exclude_args="--exclude auth_tokens.json --exclude config.json --exclude dns_cache.json --exclude gsm_operator_cache.json --exclude relays_cache.json --exclude revision --exclude setup.json"

  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    # Remote deployment mode
    echo "=== Remote Deployment Mode ==="
    
    # Check if rsync is available on the remote host
    if ! ssh "$SSH_TARGET" "command -v rsync >/dev/null 2>&1"; then
      echo "Error: rsync is not installed on the remote host ($SSH_TARGET)."
      echo "       Please install rsync on the remote host before proceeding:"
      echo "       sudo apt-get update && sudo apt-get install -y rsync"
      exit 1
    fi
    
    # Check if dist folder exists
    if [[ ! -d "$DIST_PATH" ]]; then
      echo "Error: $DIST_PATH folder not found. Please build the project first with 'pnpm build'"
      exit 1
    fi

    # Ensure rsync is installed on dev machine
    install_if_missing_dev rsync

    # Deploy files to remote machine
    copy_files "$DIST_PATH" "$BELAUI_PATH" "$exclude_args"

  else
    # Local installation mode
    echo "=== Local Installation Mode ==="
    
    # Check and install dependencies
    install_if_missing_local rsync
    install_if_missing_local wget

    # Check available disk space
    check_disk_space

    # Download and extract release
    local temp_dir=$(mktemp -d)
    echo "Downloading and extracting latest release"
    cd "$temp_dir" || exit
    if ! wget -q --show-progress "$RELEASE_URL"; then
      echo "Error: Failed to download release from $RELEASE_URL"
      rm -rf "$temp_dir"
      exit 1
    fi
    if ! tar xf "$RELEASE_TARBALL"; then
      echo "Error: Failed to extract $RELEASE_TARBALL"
      rm -rf "$temp_dir"
      exit 1
    fi

    # Ensure target directory exists
    mkdir -p "$BELAUI_PATH"

    # Copy files to target directory
    copy_files "$temp_dir" "$BELAUI_PATH" "$exclude_args"

    # Cleanup
    rm -rf "$temp_dir"
  fi

  # Common post-installation tasks
  echo "Configuring BelaUI..."
  
  # Set ownership to root:root
  execute_sudo_cmd "chown -R root:root $BELAUI_PATH"

  # Run the override script
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    execute_cmd "cd $BELAUI_PATH && [[ -f ./override-belaui.sh ]] && bash ./override-belaui.sh || echo 'Warning: override-belaui.sh not found, skipping override'"
  else
    if [[ -f "$BELAUI_PATH/override-belaui.sh" ]]; then
      execute_cmd "cd $BELAUI_PATH && bash ./override-belaui.sh"
    else
      echo "Warning: override-belaui.sh not found, skipping override"
    fi
  fi



  echo
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    echo "CeraUI monorepo deployment complete."
  else
    echo "CeraUI monorepo (frontend + belaUI backend) installed and override script executed successfully."
    echo "You can reset to default by running: sudo $BELAUI_PATH/reset-to-default.sh"
  fi
}

# Run main function
main "$@"
