#!/usr/bin/env bash
# Download Hansen Global Forest Change GeoTIFF granules.
#
# Granules are 10°×10°, named by their top-left corner (e.g. 50N_020E covers
# 40-50°N, 20-30°E — that's most of Romania, Hungary, and Ukraine).
#
# Usage:
#   bash scripts/download_hansen.sh                       # default: Transylvania (50N_020E)
#   bash scripts/download_hansen.sh 50N_020E              # one granule, lossyear only
#   bash scripts/download_hansen.sh 50N_020E --treecover  # also download treecover2000
#   bash scripts/download_hansen.sh 40N_080W 50N_080W     # multiple granules
#
# Files land in $HANSEN_DATA_DIR (default ./data/hansen). After download:
#   echo "HANSEN_DATA_DIR=./data/hansen" >> .env
#   docker compose down && make dev

set -eu

VERSION="GFC-2024-v1.12"
BASE="https://storage.googleapis.com/earthenginepartners-hansen/${VERSION}"

# Parse args
WITH_TREECOVER=false
GRANULES=()
for arg in "$@"; do
  case "$arg" in
    --treecover) WITH_TREECOVER=true ;;
    -h|--help)
      head -n 15 "$0" | tail -n 13 | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *) GRANULES+=("$arg") ;;
  esac
done

# Default to Transylvania granule
if [ ${#GRANULES[@]} -eq 0 ]; then
  GRANULES=("50N_020E")
fi

DATA_DIR="${HANSEN_DATA_DIR:-./data/hansen}"
mkdir -p "$DATA_DIR"

echo "Hansen ${VERSION} → $DATA_DIR"
echo "Granules: ${GRANULES[*]}"
echo "Treecover: $WITH_TREECOVER"
echo

# Pick downloader: prefer aria2 (parallel chunks), then curl, then wget.
DOWNLOADER=""
if command -v aria2c >/dev/null 2>&1; then
  DOWNLOADER="aria2c -x 8 -s 8 --console-log-level=warn --summary-interval=10 --auto-file-renaming=false"
elif command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl -L --continue-at - -o"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget --continue -O"
else
  echo "Need curl, wget, or aria2 installed." >&2
  exit 1
fi
echo "Using: ${DOWNLOADER%% *}"
echo

fetch() {
  # fetch <url> <out_path>
  local url=$1 out=$2
  if [ -f "$out" ]; then
    echo "  ✓ exists: $out"
    return 0
  fi
  echo "  → $url"
  case "$DOWNLOADER" in
    aria2c*) eval "$DOWNLOADER -d \"$(dirname "$out")\" -o \"$(basename "$out")\" \"$url\"" ;;
    curl*)   eval "$DOWNLOADER \"$out\" \"$url\"" ;;
    wget*)   eval "$DOWNLOADER \"$out\" \"$url\"" ;;
  esac
}

for g in "${GRANULES[@]}"; do
  echo "Granule $g:"
  fetch "${BASE}/Hansen_${VERSION}_lossyear_${g}.tif" \
        "${DATA_DIR}/Hansen_${VERSION}_lossyear_${g}.tif"
  if [ "$WITH_TREECOVER" = true ]; then
    fetch "${BASE}/Hansen_${VERSION}_treecover2000_${g}.tif" \
          "${DATA_DIR}/Hansen_${VERSION}_treecover2000_${g}.tif"
  fi
  echo
done

echo "Done."
echo
echo "Set this in backend/.env:"
echo "  HANSEN_DATA_DIR=$DATA_DIR"
if [ "$WITH_TREECOVER" = true ]; then
  echo "  HANSEN_TREECOVER_THRESHOLD=30   # matches the GFW API default"
else
  echo "  HANSEN_TREECOVER_THRESHOLD=0    # no canopy threshold (no treecover2000 downloaded)"
fi
