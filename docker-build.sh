#!/usr/bin/env sh

set -e

cd /app/

bun-$PR install --no-save
cd ui; bun-$PR install --no-save; cd ..
bun-$PR run build

rm -rf /app/dist-host/public
mv /app/dist/belaUI /app/dist-host/
mv /app/dist/public /app/dist-host/