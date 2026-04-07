#!/bin/bash
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

IMAGE_NAME="opengolem-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building OpenGolem agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo "Build complete: ${IMAGE_NAME}:${TAG}"
echo "Test with: ${CONTAINER_RUNTIME} run --rm ${IMAGE_NAME}:${TAG} --version"
