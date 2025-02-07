#!/usr/bin/env bash

WORKING_DIR=/opt/
REPOSITORY=https://github.com/datagutt/moblink-rust-relay.git
VERSION=0d65539f88292666db152d6bcb8428e44efad3a4

GIT_INSTALLED=$(git --version) || false
CURL_INSTALLED=$(curl --version) || false

# Make sure git and curl are installed
if [ -z "$GIT_INSTALLED" ] || [ -z "$CURL_INSTALLED" ]; then
  apt-get update
  apt-get install -y git curl
fi

# Add cargo to PATH
source "$HOME"/.cargo/env

# Install Rust nightly via rustup
RUST_INSTALLED=$(rustc --version) || false
if [ -z "$RUST_INSTALLED" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | TMPDIR=$XDG_RUNTIME_DIR sh -s -- --profile minimal --default-toolchain nightly -y

  # Reload PATH‚
  source "$HOME"/.cargo/env
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
git checkout $VERSION

# Pull latest changes
git pull

# Build moblink-rust-relay
cargo build --release
