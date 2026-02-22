---
name: youtube-dl
description: Download YouTube videos and audio using yt-dlp.
homepage: https://github.com/yt-dlp/yt-dlp
metadata:
  {
    "openclaw":
      {
        "emoji": "📺",
        "requires": { "bins": ["yt-dlp", "ffmpeg"] },
      },
  }
---

# YouTube Downloader (yt-dlp)

Download YouTube videos or extract audio using the bundled script.

## Quick start

Download a video (default 720p, ≤50 MB for Telegram):

```bash
{baseDir}/scripts/download.sh "https://www.youtube.com/watch?v=VIDEO_ID"
```

## Useful flags

```bash
# Audio only (MP3)
{baseDir}/scripts/download.sh "https://www.youtube.com/watch?v=VIDEO_ID" --audio-only

# Custom quality (e.g. 480p, 1080p)
{baseDir}/scripts/download.sh "https://www.youtube.com/watch?v=VIDEO_ID" --quality 480

# Custom output directory
{baseDir}/scripts/download.sh "https://www.youtube.com/watch?v=VIDEO_ID" --out-dir /tmp/videos
```

## Cookies (bot detection)

YouTube may block downloads from servers. To fix this, export cookies from a logged-in browser and place them at `~/.openclaw/yt-cookies.txt` (Netscape format).

You can also set the `YT_COOKIES` env var or pass `--cookies /path/to/cookies.txt`.

To export cookies, use a browser extension like "Get cookies.txt LOCALLY" or run:
```bash
yt-dlp --cookies-from-browser chrome --cookies-only -o /dev/null "https://www.youtube.com" 2>/dev/null
# Then copy the generated cookies file
```

## Notes

- Default max quality is 720p to stay under Telegram's 50 MB file limit.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Supports YouTube URLs, Shorts, and playlists (first video only).
- Requires `yt-dlp` and `ffmpeg` on PATH.
