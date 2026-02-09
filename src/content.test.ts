import { describe, expect, test } from 'bun:test';

function setRequiredEnvForImports() {
    process.env.ANTHROPIC_API_KEY ||= 'test';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||= 'test';
    process.env.GCS_BUCKET ||= 'test-bucket';
    process.env.HOME ||= '/tmp';
}

describe('content image handling', () => {
    test('extractImagesFromMarkdown ignores titles inside parens', async () => {
        setRequiredEnvForImports();
        const { extractImagesFromMarkdown } = await import('./content');
        const md = '![Alt](https://example.com/a.png "Title")';
        expect(extractImagesFromMarkdown(md)).toEqual(['https://example.com/a.png']);
    });

    test('extractContent absolutizes markdown image urls', async () => {
        setRequiredEnvForImports();
        const { extractContent } = await import('./content');
        const html = await Bun.file('./fixtures/relative-images.html').text();
        const baseUrl = 'https://example.com/some/page';
        const content = extractContent(html, baseUrl);
        expect(content.allImages[0]).toBe('https://example.com/img/pic.png');
        expect(content.chapters[0].images[0]).toBe('https://example.com/img/pic.png');
        expect(content.chapters[0].content).toContain('(https://example.com/img/pic.png)');
    });
});
