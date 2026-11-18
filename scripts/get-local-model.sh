#!/usr/bin/env bash
# Download a GGUF for Synape's local provider, resumably, and verify it.
#
#   scripts/get-local-model.sh                      # default: Qwen3.6-35B-A3B (MTP head) UD-Q4_K_XL
#   scripts/get-local-model.sh <hf-repo> <file.gguf>
#
# Files land in ${SYNAPE_MODELS_DIR:-~/.local/share/llm/models}. While downloading
# the file is called <name>.gguf.part, so Synape never loads a partial model.
set -euo pipefail

REPO="${1:-unsloth/Qwen3.6-35B-A3B-MTP-GGUF}"
FILE="${2:-Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf}"
DIR="${SYNAPE_MODELS_DIR:-$HOME/.local/share/llm/models}"
URL="https://huggingface.co/$REPO/resolve/main/$FILE"
mkdir -p "$DIR"
cd "$DIR"

# Hugging Face reports the LFS sha256 as the linked etag, and the real size.
HEAD="$(curl -sIL "$URL" | tr -d '\r')"
SHA="$(awk -F': ' 'tolower($1)=="x-linked-etag"{gsub(/"/,"",$2); print $2}' <<<"$HEAD" | tail -1)"
SIZE="$(awk -F': ' 'tolower($1)=="x-linked-size"{print $2}' <<<"$HEAD" | tail -1)"

if [[ -f "$FILE" && -n "$SIZE" && "$(stat -c %s "$FILE")" == "$SIZE" ]]; then
  echo "already present: $DIR/$FILE"
  exit 0
fi
# Resume a download that started under the final name.
[[ -f "$FILE" ]] && mv -f "$FILE" "$FILE.part"

echo "downloading $REPO/$FILE → $DIR"
curl -L --fail --retry 5 --retry-delay 5 -C - -o "$FILE.part" "$URL"

if [[ "$SHA" =~ ^[0-9a-f]{64}$ ]]; then
  echo "verifying sha256…"
  echo "$SHA  $FILE.part" | sha256sum -c --quiet -
fi
mv -f "$FILE.part" "$FILE"
echo "ready: $DIR/$FILE"
