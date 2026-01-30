# Podcast Mirror Project

## Goal
Create a new script `podcast-mirror.ts` that ingests a podcast feed URL and produces a mirrored podcast feed in the same storage bucket, with identical metadata but audio that has ad reads moved to the end and grouped into a dedicated chapter, preceded by a short injected voice line: "starting X spliced ad reads".

## High-level flow
1. Fetch and parse the original RSS feed URL.
2. Create a new feed folder in the same bucket named `R2M: <podcast name>`.
3. Mirror all feed metadata and episode metadata (title, description, images, etc.).
4. For each episode:
   - Download the audio.
   - Transcribe with timestamps.
   - Detect ad segments via existing AI.
   - Splice audio to remove ad reads from the main flow.
   - Append ad reads at the end in a chapter, with injected voice line.
   - Upload processed audio.
5. Emit a new RSS feed pointing to the processed audio URLs and mirrored metadata.

## Unknowns / clarifications needed
- Where to store the new feed folder and how folder names map to URLs.
- Exact RSS parsing/writing conventions used in this codebase (libraries, utilities).
- Which transcription system is available and its expected API.
- "Existing AI" for ad detection: where it lives and how to call it.
- How to generate and inject the "starting X spliced ad reads" voice line (TTS? existing voice assets?).
- Audio processing stack in repo (ffmpeg, bun, node packages) and how chapters are represented.
- Whether we need to update any indices / catalogs beyond RSS feed creation.
- Any auth or environment variables needed for storage or APIs.

## Decisions / updates
- Use Google Cloud Speech-to-Text via `@google-cloud/speech` for timestamped transcription (FLAC 16 kHz, word time offsets).
- Use Gemini (existing AI stack) for ad segment classification with a new prompt (`ad-detection.md`).
- Mirror feed title to `R2M: <podcast name>` and use a slugified version as the bucket folder name.
- Preserve original episode metadata while updating enclosure URLs, sizes, durations, and chapters.
- Splice audio by extracting PCM segments with ffmpeg, concatenating main content + TTS announcement + ad segments, and re-encoding to the original enclosure format when possible.
- Append a “Spliced Ad Reads” chapter at the end and generate JSON chapters for `podcast:chapters`.

## Progress log
- 2026-01-29: Initialized project plan and clarified unknowns.
- 2026-01-29: Added ad detection prompt + AI classifier, created `podcast-mirror.ts`, added Speech-to-Text dependency, and wired transcript/splice/chapter pipeline.
- 2026-01-30: Added episode selection flags (`--first`, `--last`, `--episode`) and skip logic for already-imported episodes.
