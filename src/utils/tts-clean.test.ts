import { describe, expect, test } from 'bun:test';
import { cleanTextForTTS, sanitizeTtsChunk } from './tts-clean';

describe('tts clean', () => {
    test('cleanTextForTTS removes markdown links and bare urls', () => {
        const input = 'See [this](https://example.com) and https://foo.bar/baz';
        const cleaned = cleanTextForTTS(input);
        expect(cleaned).toContain('See this');
        expect(cleaned).not.toContain('http');
        expect(cleaned).not.toContain('[');
        expect(cleaned).not.toContain(']');
        expect(cleaned).not.toContain('(');
        expect(cleaned).not.toContain(')');
    });

    test('sanitizeTtsChunk strips underscores and URLs for plain text', () => {
        const input = 'snake_case https://example.com';
        const out = sanitizeTtsChunk(input, false);
        expect(out).not.toContain('_');
        expect(out).not.toContain('http');
    });

    test('sanitizeTtsChunk strips underscores, markdown links, and URLs in SSML text nodes', () => {
        const input = '<speak>Hello _world_. See [site](https://example.com) and https://foo.bar</speak>';
        const out = sanitizeTtsChunk(input, true);
        expect(out).toContain('<speak>');
        expect(out).toContain('</speak>');
        expect(out).not.toContain('_');
        expect(out).not.toContain('http');
        expect(out).not.toContain('[');
        expect(out).not.toContain('](');
    });
});

