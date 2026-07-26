import { describe, expect, test } from 'bun:test';

import { chunkSegments, reconcileAdLabels } from './ad-detection';
import type { TranscriptSegment } from '../types';

function makeSegments(count: number): TranscriptSegment[] {
    return Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        startSec: index * 30,
        endSec: (index + 1) * 30,
        text: `Segment ${index + 1}`,
    }));
}

describe('ad classification batching', () => {
    test('overlaps batches so promotions spanning a boundary retain context', () => {
        const chunks = chunkSegments(makeSegments(85), 12000, 40, 3);

        expect(chunks.map(chunk => [chunk[0].index, chunk.at(-1)?.index])).toEqual([
            [1, 40],
            [38, 80],
            [78, 85],
        ]);
    });

    test('keeps the most cautious label from overlapping batches', () => {
        const segments = makeSegments(2);
        const labels = reconcileAdLabels(segments, [
            { index: 1, label: 'content' },
            { index: 1, label: 'ad', reason: 'Later context reveals sponsor read' },
            { index: 2, label: 'content' },
        ]);

        expect(labels.map(label => label.label)).toEqual(['ad', 'content']);
    });

    test('rejects missing classifications instead of treating them as content', () => {
        expect(() => reconcileAdLabels(makeSegments(2), [
            { index: 1, label: 'content' },
        ])).toThrow('missing segment indexes: 2');
    });
});
