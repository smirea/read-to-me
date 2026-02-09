import { describe, expect, test } from 'bun:test';
import { generateRssFeed } from './output/rss';

describe('rss generation', () => {
    test('psc chapter start uses HH:MM:SS.mmm', () => {
        const xml = generateRssFeed({
            title: 't',
            author: 'a',
            summary: 's',
            sourceUrl: 'https://example.com',
            audioUrl: 'https://example.com/audio.m4a',
            thumbnailUrl: 'https://example.com/thumb.png',
            audioSizeBytes: 1,
            durationMs: 2_000,
            chapters: [
                { title: 'c1', startMs: 0 },
                { title: 'c2', startMs: 1_234 },
            ],
            chaptersJsonUrl: 'https://example.com/chapters.json',
        });

        expect(xml).toContain('<psc:chapter start="00:00:00.000"');
        expect(xml).toContain('<psc:chapter start="00:00:01.234"');
    });
});

