#!/usr/bin/env bash
# Start RapidSpeech.cpp rs-server with the ASR model for the dsh plugin.
# Usage: ./scripts/start-rs-server.sh [model.gguf] [port]
set -euo pipefail

RAPIDSPEECH_DIR="${RAPIDSPEECH_DIR:-$HOME/RapidSpeech.cpp}"
MODEL="${1:-$RAPIDSPEECH_DIR/gguf_models/xasr-q8_0.gguf}"
PORT="${2:-8080}"

if [[ ! -x "$RAPIDSPEECH_DIR/build/rs-server" ]]; then
  echo "rs-server not found at $RAPIDSPEECH_DIR/build/rs-server" >&2
  echo "Build it first: cd $RAPIDSPEECH_DIR && cmake -B build -DRS_STATIC_EXE=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "ASR model not found: $MODEL" >&2
  exit 1
fi

# rs-server is dynamically linked against build-tree libraries.
export LD_LIBRARY_PATH="$RAPIDSPEECH_DIR/build:$RAPIDSPEECH_DIR/build/ggml/src${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "Starting rs-server: model=$MODEL port=$PORT"
exec "$RAPIDSPEECH_DIR/build/rs-server" \
  --asr-model "$MODEL" \
  --host 127.0.0.1 --port "$PORT"
