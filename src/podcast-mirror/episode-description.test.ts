import { describe, expect, test } from 'bun:test';

import { formatEpisodeDescription, parseEpisodeOverview } from './episode-description';

describe('podcast mirror episode descriptions', () => {
    test('parses fenced model output and rejects sections outside the ad-free transcript', () => {
        const sections = parseEpisodeOverview(`\`\`\`json
[
  { "startSegmentIndex": 2, "summary": "The guest explains the central argument" },
  { "startSegmentIndex": 3, "summary": "A sponsor offers a discount." },
  { "startSegmentIndex": 8, "summary": "They consider the practical consequences." }
]
\`\`\``, new Set([2, 8]));

        expect(sections).toEqual([
            { startSegmentIndex: 2, summary: 'The guest explains the central argument.' },
            { startSegmentIndex: 8, summary: 'They consider the practical consequences.' },
        ]);
    });

    test('formats one overview sentence per timestamp', () => {
        expect(formatEpisodeDescription([
            { startMs: 0, summary: 'The episode introduces the debate.' },
            { startMs: 3_723_900, summary: 'The hosts test the argument against recent evidence' },
        ])).toBe([
            '00:00:00 — The episode introduces the debate.',
            '01:02:03 — The hosts test the argument against recent evidence.',
        ].join('\n\n'));
    });
});
