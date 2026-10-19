#!/bin/sh
# Install subtranslate on Termux (Android) or any Linux box.
#
#   sh install.sh
#
# Then:  subtranslate "Movie.en.srt" "Movie Title"

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

echo
echo "done. try:"
echo "  subtranslate --help"
