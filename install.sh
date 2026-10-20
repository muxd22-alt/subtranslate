#!/bin/sh
# Install subtranslate on Termux (Android) or any Linux box.
#
#   sh install.sh
#
# Then:  subfind --lang en "Movie.mkv"
#        subtr "Movie.mkv"
#        subtranslate "Movie.en.srt" "Movie Title"

set -e

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "node is not installed."
    echo "On Termux:  pkg install nodejs-lts"
    exit 1
fi

echo "== installing dependencies =="
npm install

echo "== downloading the en->ar model (~34 MB, once) =="
npm run fetch-model

echo "== linking the subtranslate command =="
npm link --force >/dev/null 2>&1 || npm install -g . >/dev/null

BIN_DIR="${PREFIX:-/usr/local}/bin"
LIB_DIR="${PREFIX:-/usr/local}/lib/subtranslate"
if mkdir -p "$BIN_DIR" "$LIB_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
    echo "== installing subfind, subsync and subtr into $BIN_DIR =="
    cp lib/wrappers.sh "$LIB_DIR/wrappers.sh"
    for cmd in subfind subsync-en subtr; do
        cp "bin/$cmd" "$BIN_DIR/$cmd"
        chmod 755 "$BIN_DIR/$cmd"
    done
    chmod 644 "$LIB_DIR/wrappers.sh"
fi

echo
echo "done. try:"
echo "  subtranslate --help"
echo "  subfind --help"
echo "  subsync-en --help"
echo "  subtr --help"
