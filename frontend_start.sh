#!/bin/bash

# Start frontend script for lofAI

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/service-lifecycle.sh"
lofai_service_lifecycle_init

echo "Starting lofAI frontend..."

cd "$SCRIPT_DIR/frontend"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    lofai_run_service_command npm install
fi

# The development router is intentionally opt-in. Long-running `next dev`
# workers compete directly with MLX on an 8GB machine and stale workers can
# survive an interrupted shell. Production mode is both lighter and stable.
FRONTEND_MODE="${LOFAI_FRONTEND_MODE:-production}"
FRONTEND_PORT="${PORT:-3000}"

if command -v lsof >/dev/null 2>&1 && \
   lsof -nP -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Error: port $FRONTEND_PORT already has a listener; refusing to start a duplicate frontend."
    exit 1
fi

if [ "$FRONTEND_MODE" = "development" ] || [ "$FRONTEND_MODE" = "dev" ]; then
    echo "Starting development frontend on http://localhost:$FRONTEND_PORT"
    PORT="$FRONTEND_PORT" lofai_run_service_command npm run dev
    exit $?
fi

if [ "$FRONTEND_MODE" != "production" ]; then
    echo "Error: LOFAI_FRONTEND_MODE must be production or development."
    exit 1
fi

# Rebuild only when application source or dependency metadata changed. The
# production build is a static export (next.config.mjs): plain files in out/,
# whose own index.html is the build stamp.
BUILD_STAMP="out/index.html"
NEEDS_BUILD=0
if [ ! -f "$BUILD_STAMP" ]; then
    NEEDS_BUILD=1
elif find app components lib public -type f -newer "$BUILD_STAMP" -print -quit | grep -q .; then
    NEEDS_BUILD=1
elif [ package.json -nt "$BUILD_STAMP" ] || [ package-lock.json -nt "$BUILD_STAMP" ] || \
     [ next.config.mjs -nt "$BUILD_STAMP" ]; then
    NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" = "1" ]; then
    echo "Building optimized frontend..."
    lofai_run_service_command npm run build
fi

# Serve the export with one small static file server rather than a Next.js
# server and its render workers: the page is entirely client-side, and the
# memory goes to the model on an 8GB Mac. Loopback only, like the backend
# default; the backend's allowed origins already cover this port.
STATIC_PYTHON="$SCRIPT_DIR/venv/bin/python"
[ -x "$STATIC_PYTHON" ] || STATIC_PYTHON="$(command -v python3)"
FRONTEND_HOST="${LOFAI_FRONTEND_HOST:-127.0.0.1}"
echo "Serving production frontend on http://localhost:$FRONTEND_PORT"
lofai_run_service_command "$STATIC_PYTHON" static_server.py --port "$FRONTEND_PORT" \
    --bind "$FRONTEND_HOST" --directory out
