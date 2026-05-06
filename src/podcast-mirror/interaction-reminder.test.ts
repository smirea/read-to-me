import { describe, expect, test } from 'bun:test';

import { isInteractionReminderText } from './interaction-reminder';

describe('interaction reminder detection', () => {
    test('detects subscribe reminder', () => {
        expect(isInteractionReminderText("Don't forget to subscribe and leave us a five star review")).toBe(true);
    });

    test('detects community support reminder', () => {
        expect(isInteractionReminderText('Join our Substack and support the show on Patreon')).toBe(true);
    });

    test('detects show-note reminder', () => {
        expect(isInteractionReminderText('Links are in the show notes, follow us on Instagram')).toBe(true);
    });

    test('does not match regular editorial content', () => {
        expect(isInteractionReminderText('The study follows 500 patients over 10 years and reviews every visit.')).toBe(false);
    });
});
