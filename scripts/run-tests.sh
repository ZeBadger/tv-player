#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="node:22-alpine"
NODE_MODULES_VOLUME="tv-player-node-modules"
NPM_CACHE_VOLUME="tv-player-npm-cache"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not on PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: docker daemon is not reachable. Start docker and try again."
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

docker_tty_args=()
if [[ -t 0 && -t 1 ]]; then
  docker_tty_args=(-it)
fi

docker_base_args=(
  --rm
  -v "${repo_root}:/work"
  -v "${NODE_MODULES_VOLUME}:/work/node_modules"
  -v "${NPM_CACHE_VOLUME}:/root/.npm"
  -w /work
)

if [[ ${#docker_tty_args[@]} -gt 0 ]]; then
  docker_base_args+=("${docker_tty_args[@]}")
fi

watch=false
vitest_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--watch)
      watch=true
      shift
      ;;
    *)
      vitest_args+=("$1")
      shift
      ;;
  esac
done

if [[ "$watch" == true ]]; then
  docker run "${docker_base_args[@]}" "${DOCKER_IMAGE}" npm ci
  docker run "${docker_base_args[@]}" "${DOCKER_IMAGE}" npm test -- "${vitest_args[@]}"
else
  docker run "${docker_base_args[@]}" "${DOCKER_IMAGE}" npm ci
  docker run "${docker_base_args[@]}" "${DOCKER_IMAGE}" npm test -- --run "${vitest_args[@]}"
fi
