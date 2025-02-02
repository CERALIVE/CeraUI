#!/usr/bin/env bash

WORKING_DIR=/opt/
# Checkout the version that expects two bind addresses
VERSION=86779d444bf94afac8d97acc4af0bd2a99b8d59a

# Make sure git and curl are installed
apt-get update
apt-get install -y git curl

# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add cargo to PATH
source "$HOME"/.cargo/env

# Make sure working directory exists
mkdir -p $WORKING_DIR

# Change to working directory
cd $WORKING_DIR || exit

# Clone moblink-rust-relay
git clone https://github.com/datagutt/moblink-rust-relay.git

# Change to moblink-rust-relay directory
cd moblink-rust-relay || exit

# Checkout the version that expects two bind addresses
git checkout $VERSION

# Set nightly (optional)
rustup override set nightly

# Build moblink-rust-relay
cargo build --release
