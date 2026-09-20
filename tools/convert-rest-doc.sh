#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash tools/convert-rest-doc.sh [markdown-file] [--no-pdf]

Examples:
  bash tools/convert-rest-doc.sh
  bash tools/convert-rest-doc.sh docs/API.md
  bash tools/convert-rest-doc.sh docs/API.md --no-pdf

Defaults:
  markdown-file: docs/API.md
  Output directory: tmp/docs-exports (keeps docs limited to source guides).
  Also generates PDF unless --no-pdf is provided.
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

input_md=""
generate_pdf=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-pdf)
      generate_pdf=false
      shift
      ;;
    *)
      if [[ -z "$input_md" ]]; then
        input_md="$1"
        shift
      else
        echo "Error: Unexpected argument '$1'"
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$input_md" ]]; then
  input_md="docs/API.md"
fi

if [[ "$input_md" = /* ]]; then
  input_md_abs="$input_md"
else
  input_md_abs="${REPO_ROOT}/${input_md}"
fi

if [[ ! -f "$input_md_abs" ]]; then
  echo "Error: Markdown file not found: $input_md_abs"
  exit 1
fi

if ! command -v pandoc >/dev/null 2>&1; then
  echo "Error: pandoc is not installed or not on PATH"
  exit 1
fi

out_dir="${REPO_ROOT}/tmp/docs-exports"
mkdir -p -- "$out_dir"
base_name="$(basename -- "$input_md_abs" .md)"
out_docx="${out_dir}/${base_name}.docx"
out_pdf="${out_dir}/${base_name}.pdf"

echo "Generating DOCX from: $input_md_abs"
pandoc "$input_md_abs" \
  --from gfm \
  --to docx \
  --output "$out_docx"

echo "DOCX generated: $out_docx"

if [[ "$generate_pdf" == true ]]; then
  if ! command -v soffice >/dev/null 2>&1; then
    echo "Error: soffice (LibreOffice) is not installed or not on PATH"
    echo "Tip: Re-run with --no-pdf to only generate DOCX"
    exit 1
  fi

  echo "Generating PDF from DOCX..."
  soffice --headless \
    --convert-to pdf \
    --outdir "$out_dir" \
    "$out_docx" >/dev/null

  echo "PDF generated: $out_pdf"
fi

echo "Done."
