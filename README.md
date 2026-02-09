# Read To Me

Converts web articles into audio using Google's Chirp 3 HD text-to-speech. Like NotebookLM but just reads articles aloud.

```bash
bun src/read-to-me.ts <url> [options]
```

### Features

- Extracts article content via Mozilla Readability
- AI-powered filtering of ads/comments (Gemini)
- AI image descriptions for richer listening (skips stock photos)
- AI table analysis with narrative insights
- Speech enhancement with SSML for natural-sounding audio
- Chapter-based M4A output with embedded metadata
- AI-generated thumbnails with consistent branding
- RSS feed generation for podcast apps (Overcast, etc.)
- Narrator attribution in audio metadata

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--voice` | `-v` | Voice for TTS | `Zephyr` |
| `--dialect` | `-d` | English dialect | `en-GB` |
| `--output` | `-o` | Output directory path | auto |
| `--enhance-speech` | | Enhance text for TTS with SSML | `true` |
| `--cache-images` | | Cache AI image parsing results (1 week TTL) | `true` |
| `--skip-upload` | | Skip uploading to GCS bucket | `false` |

**Voices:** `Aoede`, `Charon`, `Fenrir`, `Kore`, `Leda`, `Orus`, `Puck`, `Zephyr`, `random`, `random-male`, `random-female`

**Dialects:** `en-AU`, `en-GB`, `en-IN`, `en-US`

### Examples

```bash
bun src/read-to-me.ts https://example.com/article
bun src/read-to-me.ts https://example.com/article --voice Charon --dialect en-US
bun src/read-to-me.ts https://example.com/article -v random-female -o my-article
bun src/read-to-me.ts https://example.com/article --no-enhance-speech --skip-upload
```

### Output

Creates an output directory with:
- Chapter audio files + combined M4A with embedded chapters
- `chapters.json` with metadata
- `thumbnail.png` for podcast apps
- `feed.xml` RSS feed for the episode
- Original markdown and images

When uploaded (default), also updates the master RSS feed at:
`https://storage.googleapis.com/stefan-rss-feed/read-to-me/feed.xml`

### Setup

1. Install dependencies: `bun install`
2. Set required environment variables (see `src/config.ts`):
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_GENERATIVE_AI_API_KEY`
   - `GCS_BUCKET`
3. Add your GCP Text-to-Speech service account key at `gcp-key.json`
4. Configure the GCS bucket (default: `stefan-rss-feed`) with public read access for RSS + media uploads

### Development

- `bun run start <url>`: run once
- `bun run dev`: auto-reload while editing `src/read-to-me.ts`

## Podcast Mirror (Ad Splicing)

`src/podcast-mirror.ts` mirrors an existing podcast RSS feed into the same GCS bucket, rewriting episode enclosures to point at processed audio where ad reads are moved to the end.

Example:

```bash
bun src/podcast-mirror.ts https://example.com/feed.xml --limit 3
```

Incremental workflow:

- First run a subset (for speed/cost) using `--limit`, `--first`, `--last`, or one or more `--episode` filters.
- Re-run later with a different subset. Episodes already present in the mirrored feed will be kept pointing at the mirrored enclosure URLs, so the mirror feed won’t regress on subsequent runs.
