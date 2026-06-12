#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

VERSION=$(node -p "require('./packages/core/package.json').version")
TAG="v${VERSION}"

if git rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists."
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: would create tag ${TAG}"
  exit 0
fi

git tag -a "${TAG}" -m "Release ${TAG}"
echo "Created annotated tag ${TAG}"
