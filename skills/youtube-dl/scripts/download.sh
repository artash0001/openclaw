#!/usr/bin/env bash
set -euo pipefail

MAX_FILESIZE="50M"   # Telegram bot upload limit
DEFAULT_QUALITY=360

usage() {
  cat >&2 <<'EOF'
Usage:
  download.sh <URL> [--audio-only] [--quality 720] [--out-dir /tmp/videos]
  download.sh --bg <URL> [options]    Start download in background, returns job dir
  download.sh --status <JOB_DIR>      Check download progress

Options:
  --audio-only      Extract audio as MP3
  --quality N       Max video height in pixels (default: 360)
  --out-dir DIR     Output directory (default: auto temp dir)
  --bg              Run download in background (returns immediately)
  --status DIR      Check status of background download
EOF
  exit 2
}

# --- STATUS MODE ---
if [[ "${1:-}" == "--status" ]]; then
  job_dir="${2:-}"
  if [[ -z "$job_dir" || ! -d "$job_dir" ]]; then
    echo "Error: provide a valid job directory" >&2
    exit 1
  fi
  status_file="$job_dir/status.txt"
  if [[ ! -f "$status_file" ]]; then
    echo "STATUS: waiting"
    exit 0
  fi
  cat "$status_file"
  exit 0
fi

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

# --- PARSE ARGS ---
bg_mode=false
if [[ "${1:-}" == "--bg" ]]; then
  bg_mode=true
  shift
fi

url="$1"
shift

audio_only=false
quality="$DEFAULT_QUALITY"
out_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --audio-only)
      audio_only=true
      shift
      ;;
    --quality)
      quality="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

# Validate URL looks like a YouTube link
if ! echo "$url" | grep -qiE '(youtube\.com|youtu\.be)'; then
  echo "Error: URL does not look like a YouTube link: $url" >&2
  exit 1
fi

# Create temp output directory if not specified
if [[ -z "$out_dir" ]]; then
  out_dir=$(mktemp -d /tmp/yt-dl-XXXXXX)
else
  mkdir -p "$out_dir"
fi

# --- BACKGROUND MODE: launch self without --bg, write status ---
if [[ "$bg_mode" == true ]]; then
  echo "JOB_DIR: $out_dir"
  echo "STATUS: starting" > "$out_dir/status.txt"
  # Re-run this script without --bg, in background
  args=("$url")
  [[ "$audio_only" == true ]] && args+=(--audio-only)
  [[ "$quality" != "$DEFAULT_QUALITY" ]] && args+=(--quality "$quality")
  args+=(--out-dir "$out_dir")
  nohup bash "$0" "${args[@]}" > "$out_dir/log.txt" 2>&1 &
  echo "PID: $!"
  exit 0
fi

# --- Status helper ---
write_status() {
  echo "$1" > "$out_dir/status.txt"
}

# Use yt-dlp-proxy which auto-finds a working proxy to bypass YouTube IP blocks
YTDLP="yt-dlp-proxy"
if ! command -v yt-dlp-proxy &>/dev/null; then
  YTDLP="yt-dlp"
fi

write_status "STATUS: downloading
STAGE: proxy lookup"

# Build download command
if [[ "$audio_only" == true ]]; then
  echo "Downloading audio from: $url"
  write_status "STATUS: downloading
STAGE: audio download"
  $YTDLP \
    --no-playlist \
    --extract-audio \
    --audio-format mp3 \
    --audio-quality 0 \
    --format "ba[protocol=https]/ba" \
    --restrict-filenames \
    --output "$out_dir/%(title)s.%(ext)s" \
    --no-warnings \
    --quiet \
    --progress \
    "$url"
else
  echo "Downloading video from: $url (max ${quality}p)"
  write_status "STATUS: downloading
STAGE: video stream"
  $YTDLP \
    --no-playlist \
    --format "bv[height<=144][protocol=https]+wa[protocol=https]/wv[protocol=https]+wa[protocol=https]/w[protocol=https]" \
    --merge-output-format mp4 \
    --restrict-filenames \
    --output "$out_dir/%(title)s.%(ext)s" \
    --no-warnings \
    --quiet \
    --progress \
    "$url"
fi

write_status "STATUS: processing
STAGE: checking file"

# Find the downloaded file (most recent in the output dir)
downloaded=$(find "$out_dir" -type f \( -name '*.mp4' -o -name '*.mp3' -o -name '*.m4a' -o -name '*.webm' \) ! -name 'compressed_*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

if [[ -z "$downloaded" || ! -f "$downloaded" ]]; then
  write_status "STATUS: error
ERROR: Download failed — no output file found"
  echo "Error: Download failed — no output file found." >&2
  exit 1
fi

# Check file size
filesize=$(stat -c%s "$downloaded" 2>/dev/null || stat -f%z "$downloaded" 2>/dev/null)
filesize_mb=$((filesize / 1024 / 1024))

if [[ $filesize -gt 52428800 ]]; then
  write_status "STATUS: compressing
STAGE: file is ${filesize_mb}MB, compressing to <50MB"

  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$downloaded" 2>/dev/null | cut -d. -f1)
  if [[ -n "$duration" && "$duration" -gt 0 ]]; then
    target_bitrate=$(( 45 * 8 * 1024 / duration ))k
  else
    target_bitrate="500k"
  fi

  compressed="$out_dir/compressed_$(basename "${downloaded%.*}").mp4"
  ffmpeg -hide_banner -loglevel warning -y \
    -i "$downloaded" \
    -vf "scale=-2:min(${quality}\,ih)" \
    -c:v libx264 -preset fast -b:v "$target_bitrate" -maxrate "$target_bitrate" -bufsize "${target_bitrate}" \
    -c:a aac -b:a 96k \
    -movflags +faststart \
    -fs 49M \
    "$compressed"

  if [[ -f "$compressed" ]]; then
    rm -f "$downloaded"
    downloaded="$compressed"
    filesize=$(stat -c%s "$downloaded" 2>/dev/null || stat -f%z "$downloaded" 2>/dev/null)
    filesize_mb=$((filesize / 1024 / 1024))
  else
    echo "Warning: Compression failed, sending original file." >&2
  fi
fi

write_status "STATUS: done
FILE: $downloaded
SIZE: ${filesize_mb}MB"

echo ""
echo "Downloaded: $downloaded (${filesize_mb}MB)"
echo "MEDIA: $downloaded"
