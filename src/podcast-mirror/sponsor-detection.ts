import type { TranscriptWord } from '../types';

export interface SponsorKeywordRange {
    startSec: number;
    endSec: number;
    hits: string[];
}

const SPONSOR_PHRASES = [
    ['our', 'sponsor'],
    ['sponsor', 'of', 'this', 'podcast'],
    ['sponsored', 'by'],
    ['brought', 'to', 'you', 'by'],
    ['support', 'for', 'this', 'podcast', 'comes', 'from'],
    ['use', 'code'],
    ['promo', 'code'],
    ['percent', 'off'],
    ['dollars', 'off'],
    ['free', 'trial'],
    ['free', 'gift'],
    ['limited', 'time', 'offer'],
    ['terms', 'apply'],
    ['prescription', 'hair', 'loss'],
    ['hair', 'loss', 'treatments'],
    ['personalized', 'treatment', 'plans'],
    ['no', 'hidden', 'fees'],
    ['free', 'online', 'visit'],
    ['compounded', 'drug', 'products'],
    ['important', 'safety', 'information'],
    ['individual', 'results', 'may', 'vary'],
    ['minoxidil'],
    ['finasteride'],
];

const DECISIVE_SPONSOR_PHRASES = new Set([
    'our sponsor',
    'sponsor of this podcast',
    'sponsored by',
    'brought to you by',
    'support for this podcast comes from',
]);

const GROUP_MAX_GAP_SEC = 90;
const PAD_BEFORE_SEC = 30;
const PAD_AFTER_SEC = 10;
const DECISIVE_SINGLE_HIT_PAD_AFTER_SEC = 45;

interface SponsorHit {
    phrase: string;
    tokenCount: number;
    startSec: number;
    endSec: number;
}

export function detectSponsorKeywordRanges(words: TranscriptWord[], totalDurationSec: number): SponsorKeywordRange[] {
    if (words.length === 0) return [];

    const tokens = words.map(word => normalizeToken(word.word));
    const hits: SponsorHit[] = [];

    for (let index = 0; index < tokens.length; index++) {
        for (const phrase of SPONSOR_PHRASES) {
            if (!matchesPhrase(tokens, index, phrase)) continue;
            hits.push({
                phrase: phrase.join(' '),
                tokenCount: phrase.length,
                startSec: words[index].startSec,
                endSec: words[index + phrase.length - 1].endSec,
            });
        }
    }

    return groupSponsorHits(hits, totalDurationSec);
}

function groupSponsorHits(hits: SponsorHit[], totalDurationSec: number): SponsorKeywordRange[] {
    if (hits.length === 0) return [];

    const groups: SponsorHit[][] = [];
    let current: SponsorHit[] = [];

    for (const hit of hits.sort((a, b) => a.startSec - b.startSec)) {
        const previous = current[current.length - 1];
        if (!previous || hit.startSec - previous.endSec <= GROUP_MAX_GAP_SEC) {
            current.push(hit);
            continue;
        }

        groups.push(current);
        current = [hit];
    }
    if (current.length > 0) groups.push(current);

    return groups.flatMap(group => {
        const hasStrongPhrase = group.some(hit => hit.tokenCount > 1);
        const hasDecisivePhrase = group.some(hit => DECISIVE_SPONSOR_PHRASES.has(hit.phrase));
        if ((!hasDecisivePhrase && group.length < 2) || !hasStrongPhrase) return [];

        const startSec = Math.max(0, group[0].startSec - PAD_BEFORE_SEC);
        const padAfterSec = group.length === 1 && hasDecisivePhrase
            ? DECISIVE_SINGLE_HIT_PAD_AFTER_SEC
            : PAD_AFTER_SEC;
        const endSec = Math.min(totalDurationSec, group[group.length - 1].endSec + padAfterSec);
        if (endSec <= startSec) return [];

        return [{
            startSec,
            endSec,
            hits: [...new Set(group.map(hit => hit.phrase))],
        }];
    });
}

function matchesPhrase(tokens: string[], startIndex: number, phrase: string[]): boolean {
    if (startIndex + phrase.length > tokens.length) return false;

    for (let index = 0; index < phrase.length; index++) {
        if (tokens[startIndex + index] !== phrase[index]) return false;
    }
    return true;
}

function normalizeToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
