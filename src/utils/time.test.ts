import { describe, expect, test } from 'bun:test';
import { formatChapterTime, parseTimeToMs } from './time';

describe('time utils', () => {
    test('formatChapterTime uses HH:MM:SS.mmm with zero padding', () => {
        expect(formatChapterTime(0)).toBe('00:00:00.000');
        expect(formatChapterTime(1)).toBe('00:00:00.001');
        expect(formatChapterTime(62_003)).toBe('00:01:02.003');
        expect(formatChapterTime(3_723_004)).toBe('01:02:03.004');
    });

    test('parseTimeToMs supports HH:MM:SS and HH:MM:SS.mmm', () => {
        expect(parseTimeToMs('1:02:03')).toBe(3_723_000);
        expect(parseTimeToMs('01:02:03.004')).toBe(3_723_004);
    });

    test('parseTimeToMs supports MM:SS and MM:SS.mmm', () => {
        expect(parseTimeToMs('02:03')).toBe(123_000);
        expect(parseTimeToMs('02:03.250')).toBe(123_250);
    });
});

