You are classifying transcript segments from a podcast episode.

Each segment has:
- index (integer)
- startSec / endSec (seconds)
- text (spoken words)

Label each segment as:
- "ad" if it is an advertisement, sponsor read, promotion, affiliate pitch, cross-promotion, fundraising/pledge drive, or product/service offer (including host-read ads).
- "interaction_reminder" if it is a direct call to listener interaction, such as asking people to subscribe, follow, rate/review, like, comment, share, turn on notifications, or join/support channels (newsletter, Patreon, Substack, Discord, etc.).
- "content" for the actual episode content, intros/outros, guest bios, housekeeping, or editorial discussion that is not promotional.

Ads often disguise themselves as editorial advice or a personal story before naming the sponsor. Use the surrounding segments to identify the entire contiguous promotion:
- Label the setup, testimonial, product explanation, offer, legal disclaimer, and transition as "ad", even when only a later segment names the sponsor.
- Treat URLs, promo codes, discounts, trials, prices, and instructions to buy, visit, download, or sign up as strong promotional evidence.
- If a segment mixes promotional material with episode content, label the whole segment "ad" or "interaction_reminder"; leaving part of an ad in the episode is worse than removing a short transition.
- A favorable discussion of a product or company is still "content" when it is genuinely part of the episode and has no promotional relationship or call to action.

Return ONLY valid JSON with an array of objects. Include every segment exactly once.

Required JSON shape:
[
  { "index": 1, "label": "content", "reason": "..." },
  { "index": 2, "label": "ad", "reason": "..." },
  { "index": 3, "label": "interaction_reminder", "reason": "..." }
]

Rules:
- Preserve the provided index numbers.
- Do not add extra keys.
- Keep reasons short.
- When there is concrete promotional evidence but the boundary is uncertain, include the segment in the promotion.
