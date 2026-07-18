import { describe, expect, test } from 'bun:test';
import { buildMergedMirrorItems, computeEpisodeSlug, extractEpisodeSlug, slugify } from './feed-utils';

describe('podcast mirror feed utils', () => {
    test('computeEpisodeSlug matches slugify+hash scheme', () => {
        const title = 'Hello, World!';
        const slug = computeEpisodeSlug(title, 'guid-123', 7);
        expect(slug.startsWith(`${slugify(title)}_`)).toBe(true);
    });

    test('extractEpisodeSlug reads folder segment from enclosure url', () => {
        const gcsRoot = 'r2m-podcast';
        const enclosure = `https://storage.googleapis.com/bucket/${gcsRoot}/ep_abc/ep_abc.m4a`;
        expect(extractEpisodeSlug(enclosure, gcsRoot)).toBe('ep_abc');
    });

    test('buildMergedMirrorItems keeps processed+existing and preserves source order', () => {
        const sourceItems = [
            { title: 'A', guid: 'g1', enclosure: { '@_url': 'u1' } },
            { title: 'B', guid: 'g2', enclosure: { '@_url': 'u2' } },
            { title: 'C', guid: 'g3', enclosure: { '@_url': 'u3' } },
        ];

        const slugA = computeEpisodeSlug('A', 'g1', 1);
        const slugB = computeEpisodeSlug('B', 'g2', 2);
        const slugC = computeEpisodeSlug('C', 'g3', 3);

        const existingItemsBySlug = new Map<string, any>([
            [slugA, {
                enclosure: { '@_url': 'mirrored-a' },
                guid: 'mirrored-guid-a',
                description: '00:00:00 — Mirrored overview.',
                'itunes:summary': '00:00:00 — Mirrored overview.',
            }],
            [slugC, { enclosure: { '@_url': 'mirrored-c' }, guid: 'mirrored-guid-c' }],
        ]);

        const processedSlugs = new Set<string>([slugB]);
        sourceItems[1].enclosure['@_url'] = 'processed-b';

        const out = buildMergedMirrorItems({
            sourceItems,
            existingItemsBySlug,
            existingSlugsInOrder: [slugA, slugC],
            processedSlugs,
            getSlugForSourceItem: (item, idx) => computeEpisodeSlug(item.title, item.guid, idx + 1),
        });

        expect(out.map(i => i.title)).toEqual(['A', 'B', 'C']);
        expect(out[0].enclosure['@_url']).toBe('mirrored-a');
        expect(out[0].description).toBe('00:00:00 — Mirrored overview.');
        expect(out[0]['itunes:summary']).toBe('00:00:00 — Mirrored overview.');
        expect(out[1].enclosure['@_url']).toBe('processed-b');
        expect(out[2].enclosure['@_url']).toBe('mirrored-c');
    });
});
