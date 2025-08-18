#!/usr/bin/env bash

WORKING_DIR=/opt/
REPOSITORY=https://github.com/datagutt/moblink-rust-relay.git
VERSION=797985109606ce630131c8cc51aa024868dca0b2

# Check if dependencies are installed
GIT_INSTALLED=$(git --version 2>/dev/null) || false
CURL_INSTALLED=$(curl --version 2>/dev/null) || false

# Stop on error
set -e

# Make sure git and curl are installed
if [ -z "$GIT_INSTALLED" ] || [ -z "$CURL_INSTALLED" ]; then
  echo "Installing git and curl"

  apt-get update
  apt-get install -y git curl
fi

# Check if rust is installed
set +e
# Add cargo to PATH
. "$HOME/.cargo/env" > /dev/null 2>&1 || true
RUST_INSTALLED=$(rustc --version > /dev/null 2>&1 || false)
set -e

if [ -z "$RUST_INSTALLED" ]; then
  echo "Installing Rust nightly via rustup"

  mkdir -p "$HOME"/.tmp/moblink-rust-relay || true

  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | TMPDIR="$HOME"/.tmp/moblink-rust-relay sh -s -- --quiet --profile minimal --default-toolchain nightly -y

  # Reload PATH
  . "$HOME/.cargo/env"
else
  echo "Rust is already installed"
fi

# Make sure working directory exists
mkdir -p $WORKING_DIR

# Change to working directory
cd $WORKING_DIR || exit

# Clone or update moblink-rust-relay
if [ -d "moblink-rust-relay" ]; then
  # Change to moblink-rust-relay directory
  cd moblink-rust-relay || exit

  # Update remote origin
  git remote set-url origin "$REPOSITORY"

  # Pull latest changes
  git fetch --tags
else
  # Clone moblink-rust-relay
  git clone "$REPOSITORY"

  # Change to moblink-rust-relay directory
  cd moblink-rust-relay || exit
fi

# Checkout the version that expects two bind addresses
git checkout $VERSION --force --quiet

# Pull latest changes
git pull --force --quiet > /dev/null 2>&1 || true

# Build moblink-rust-relay
cargo build --release
