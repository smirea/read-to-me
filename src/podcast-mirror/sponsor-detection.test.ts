import { describe, expect, test } from 'bun:test';

import { detectSponsorKeywordRanges } from './sponsor-detection';
import type { TranscriptWord } from '../types';

function wordsFrom(text: string, startSec = 100): TranscriptWord[] {
    return text.split(/\s+/).map((word, index) => ({
        word,
        startSec: startSec + index,
        endSec: startSec + index + 0.8,
    }));
}

describe('sponsor keyword detection', () => {
    test('catches a host-read sponsor pitch and includes its editorial setup', () => {
        const words = wordsFrom(
            'Starting a store can feel overwhelming before you take the first step. Our sponsor makes it easy. Sign up for a free trial and use code BARTLETT for thirty percent off.',
        );

        expect(detectSponsorKeywordRanges(words, 300)).toEqual([{
            startSec: 82,
            endSec: 140.8,
            hits: ['our sponsor', 'free trial', 'use code', 'percent off'],
        }]);
    });

    test('does not treat an isolated discount discussion as a sponsor read', () => {
        const words = wordsFrom('The policy reduced energy costs by thirty percent off the previous peak.');

        expect(detectSponsorKeywordRanges(words, 300)).toEqual([]);
    });
});
