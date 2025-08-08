#!/usr/bin/env bash

# Unified BelaUI Installation Script
# 
# Usage:
#   ./install.sh                             # Local installation from GitHub releases
#   ./install.sh --remote [SSH_TARGET]       # Remote deployment from local dist folder
#   ./install.sh --help                      # Show help
#
# Environment Variables:
#   USE_CERAUI=true                          # Install CeraUI interface instead of standard BelaUI

# This script uses strict error handling:
#   - set -e: Exit immediately if any command returns a non-zero status.
#   - set -u: Treat unset variables as errors and exit immediately.
#   - set -o pipefail: Ensure that a pipeline fails if any command in it fails.
set -euo pipefail

# Default values
DEPLOY_MODE="local"
SSH_TARGET=""
USE_CERAUI=${USE_CERAUI:-false}
BELAUI_PATH="/opt/belaUI"

# GitHub release configuration
RELEASE_TARBALL="belaUI.tar.xz"
RELEASE_URL="https://github.com/CERALIVE/belaUI-ts/releases/latest/download/$RELEASE_TARBALL"
CERAUI_RELEASE_TARBALL="ceraui-main.tar.xz"
CERAUI_RELEASE_URL="https://github.com/CERALIVE/CeraUI/releases/latest/download/$CERAUI_RELEASE_TARBALL"

# Local deployment configuration
DIST_PATH="dist"

# Show help function
show_help() {
  cat << EOF
Unified BelaUI Installation Script

USAGE:
  $0 [OPTIONS] [SSH_TARGET]

OPTIONS:
  --remote, -r        Deploy from local dist folder to remote machine via SSH
  --help, -h          Show this help message

ARGUMENTS:
  SSH_TARGET          SSH target for remote deployment (default: root@belabox.local)
                      Only used with --remote option

ENVIRONMENT VARIABLES:
  USE_CERAUI=true     Install CeraUI interface instead of standard BelaUI

EXAMPLES:
  # Local installation from GitHub releases
  $0
  USE_CERAUI=true $0

  # Remote deployment from local dist folder
  $0 --remote
  $0 --remote root@192.168.1.100
  USE_CERAUI=true $0 --remote user@belabox.local

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

# Detect OS and package manager
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

# Function to check for a command and install it if missing (local mode only)
install_if_missing_local() {
  local cmd=$1
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Installing missing dependency: $cmd"
    sudo apt-get update
    sudo apt-get install -y "$cmd"
  fi
}

# Function to check for a command and install it if missing (for dev machine in remote mode)
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

# Function to check available disk space (Linux only)
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

# Function to execute commands locally or remotely
execute_cmd() {
  local cmd="$1"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    ssh "$SSH_TARGET" "$cmd"
  else
    eval "$cmd"
  fi
}

# Function to execute commands with sudo locally or remotely
execute_sudo_cmd() {
  local cmd="$1"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    ssh "$SSH_TARGET" "$cmd"
  else
    sudo bash -c "$cmd"
  fi
}

# Function to copy files locally or remotely
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

# Function to install CeraUI
install_ceraui() {
  if [[ "$USE_CERAUI" != "true" ]]; then
    return 0
  fi

  echo "Downloading and installing CeraUI content"

  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    # Create a temporary script to download and extract CeraUI on the remote machine
    local tmp_script=$(cat <<'EOF'
#!/bin/bash
set -e
CERAUI_TEMP_DIR="$(mktemp -d)"
cd "$CERAUI_TEMP_DIR"
wget -q --show-progress CERAUI_RELEASE_URL
tar xf CERAUI_RELEASE_TARBALL
rsync -rltz --delete --chown=root:root "$CERAUI_TEMP_DIR/" BELAUI_PATH/public/
rm -rf "$CERAUI_TEMP_DIR"
EOF
)

    # Replace placeholders with actual values
    tmp_script=${tmp_script//CERAUI_RELEASE_URL/$CERAUI_RELEASE_URL}
    tmp_script=${tmp_script//CERAUI_RELEASE_TARBALL/$CERAUI_RELEASE_TARBALL}
    tmp_script=${tmp_script//BELAUI_PATH/$BELAUI_PATH}

    # Execute the script on the remote machine
    ssh "$SSH_TARGET" "bash -s" <<< "$tmp_script"
  else
    # Local installation
    local ceraui_temp_dir=$(mktemp -d)
    cd "$ceraui_temp_dir" || exit

    # Download and extract CeraUI
    if ! wget -q --show-progress "$CERAUI_RELEASE_URL"; then
      echo "Error: Failed to download CeraUI from $CERAUI_RELEASE_URL"
      rm -rf "$ceraui_temp_dir"
      exit 1
    fi
    if ! tar xf "$CERAUI_RELEASE_TARBALL"; then
      echo "Error: Failed to extract $CERAUI_RELEASE_TARBALL"
      rm -rf "$ceraui_temp_dir"
      exit 1
    fi

    # Replace the content of the public folder
    sudo rsync -rltz --delete --chown=root:root "$ceraui_temp_dir/" "$BELAUI_PATH/public/"

    # Cleanup
    rm -rf "$ceraui_temp_dir"
  fi

  echo "CeraUI installed successfully."
}

# Main execution
main() {
  echo "BelaUI Installation Script"
  echo "Mode: $DEPLOY_MODE"
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    echo "Target: $SSH_TARGET"
  fi
  echo "CeraUI: $USE_CERAUI"
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
      echo "Error: $DIST_PATH folder not found. Please build the project first with 'bun run build'"
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

  # Install CeraUI if requested
  install_ceraui

  echo
  if [[ "$DEPLOY_MODE" == "remote" ]]; then
    echo "Deployment complete."
  else
    echo "BelaUI installed and override script executed successfully."
    echo "You can reset to default by running: sudo $BELAUI_PATH/reset-to-default.sh"
  fi
}

# Run main function
main "$@"
