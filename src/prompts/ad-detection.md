You are classifying transcript segments from a podcast episode.

Each segment has:
- index (integer)
- startSec / endSec (seconds)
- text (spoken words)

Label each segment as:
- "ad" if it is an advertisement, sponsor read, promotion, affiliate pitch, cross-promotion, fundraising/pledge drive, or product/service offer (including host-read ads).
- "content" for the actual episode content, intros/outros, guest bios, housekeeping, or editorial discussion that is not promotional.

Return ONLY valid JSON with an array of objects. Include every segment exactly once.

Required JSON shape:
[
  { "index": 1, "label": "content", "reason": "..." },
  { "index": 2, "label": "ad", "reason": "..." }
]

Rules:
- Preserve the provided index numbers.
- Do not add extra keys.
- Keep reasons short.
- If unsure, prefer "content".
