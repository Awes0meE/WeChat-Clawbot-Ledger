#!/bin/zsh
set -eu
cd "$(dirname "$0")/../.."
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose -f deploy/docker/compose.test.yml --profile tools run --rm -it cli \
  /app/openclaw.mjs models auth login --provider openai --agent bookkeeper --device-code
