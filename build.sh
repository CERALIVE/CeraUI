#!/bin/bash

PR=17269
IMAGE_NAME="bun-linux-arm64-$PR"

# Build without cache
docker build --platform linux/arm64 --build-arg PR=$PR -t $IMAGE_NAME .

# Mount everything, but overlay with a named volume …/ui/node_modules so it can be reinstalled in the container
docker run --rm \
  --platform linux/arm64 \
  -v "$(pwd)/docker-build.sh:/app/docker-build.sh:ro" \
  -v "$(pwd)/package.json:/app/package.json:ro" \
  -v "$(pwd)/server:/app/server:ro" \
  -v "$(pwd)/ui:/app/ui:ro" \
  -v "$(pwd)/ui/dist:/app/ui/dist" \
  -v "$(pwd)/dist:/app/dist-host" \
  -v "bun-linux-arm64-$PR-ui-node_modules:/app/ui/node_modules" \
  -e PR=$PR \
  $IMAGE_NAME ./docker-build.sh
