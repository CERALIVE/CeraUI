#!/usr/bin/env bash

WORKING_DIR=/opt/
# Checkout the version that expects two bind addresses
VERSION=86779d444bf94afac8d97acc4af0bd2a99b8d59a

# Make sure git and curl are installed
apt-get update
apt-get install -y git curl

# Install Rust nightly via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | TMPDIR=$XDG_RUNTIME_DIR sh -s -- --profile minimal --default-toolchain nightly -y

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

# Build moblink-rust-relay
cargo build --release
