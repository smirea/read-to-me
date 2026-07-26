import chalk from 'chalk';
import path from 'path';
import pLimit from 'p-limit';
import { generateText, jsonSchema, Output } from 'ai';
import { geminiFlashModel } from '../clients';
import { PROMPTS_DIR, GEMINI_CONCURRENCY } from '../constants';
import { withRetry } from '../utils/retry';
import type { AdSegmentLabel, TranscriptSegment } from '../types';

const aiLimit = pLimit(GEMINI_CONCURRENCY);
const adLabelSchema = jsonSchema<AdSegmentLabel>({
    type: 'object',
    properties: {
        index: { type: 'number' },
        label: {
            type: 'string',
            enum: ['ad', 'content', 'interaction_reminder'],
        },
        reason: { type: 'string' },
    },
    required: ['index', 'label', 'reason'],
    additionalProperties: false,
});

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'ad-detection.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Ad detection prompt not found at: ${promptPath}`);
    }
    return file.text();
}

export function chunkSegments(
    segments: TranscriptSegment[],
    maxChars = 12000,
    maxSegments = 40,
    overlapSegments = 3,
): TranscriptSegment[][] {
    const ranges: Array<{ start: number; end: number }> = [];
    let start = 0;
    let currentChars = 0;

    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const serialized = JSON.stringify(segment);
        const nextChars = currentChars + serialized.length;
        if (index > start && (index - start >= maxSegments || nextChars > maxChars)) {
            ranges.push({ start, end: index });
            start = index;
            currentChars = serialized.length;
        } else {
            currentChars = nextChars;
        }
    }

    if (start < segments.length) ranges.push({ start, end: segments.length });

    return ranges.map((range, index) => segments.slice(
        index === 0 ? range.start : Math.max(0, range.start - overlapSegments),
        range.end,
    ));
}

function validateBatchLabels(batch: TranscriptSegment[], labels: AdSegmentLabel[]): AdSegmentLabel[] {
    if (!Array.isArray(labels)) {
        throw new Error('Ad-label response is not an array');
    }

    const expectedIndexes = new Set(batch.map(segment => segment.index));
    const labelMap = new Map<number, AdSegmentLabel>();

    for (const label of labels) {
        if (
            typeof label?.index !== 'number'
            || !expectedIndexes.has(label.index)
            || !['ad', 'content', 'interaction_reminder'].includes(label.label)
            || labelMap.has(label.index)
        ) {
            throw new Error(`Invalid ad label: ${JSON.stringify(label)}`);
        }
        labelMap.set(label.index, label);
    }

    const missingIndexes = batch
        .map(segment => segment.index)
        .filter(index => !labelMap.has(index));
    if (missingIndexes.length > 0) {
        throw new Error(`Ad-label response omitted segment indexes: ${missingIndexes.join(', ')}`);
    }

    return batch.map(segment => labelMap.get(segment.index)!);
}

const LABEL_PRIORITY: Record<AdSegmentLabel['label'], number> = {
    content: 0,
    interaction_reminder: 1,
    ad: 2,
};

export function reconcileAdLabels(segments: TranscriptSegment[], labels: AdSegmentLabel[]): AdSegmentLabel[] {
    const labelMap = new Map<number, AdSegmentLabel>();

    for (const label of labels) {
        const current = labelMap.get(label.index);
        if (!current || LABEL_PRIORITY[label.label] > LABEL_PRIORITY[current.label]) {
            labelMap.set(label.index, label);
        }
    }

    const missingIndexes = segments
        .map(segment => segment.index)
        .filter(index => !labelMap.has(index));
    if (missingIndexes.length > 0) {
        throw new Error(`Ad classification missing segment indexes: ${missingIndexes.join(', ')}`);
    }

    return segments.map(segment => labelMap.get(segment.index)!);
}

export async function classifyAdSegments(segments: TranscriptSegment[]): Promise<AdSegmentLabel[]> {
    if (segments.length === 0) return [];

    const prompt = await loadPrompt();
    const batches = chunkSegments(segments);

    const results = await Promise.all(batches.map(batch => aiLimit(async () => withRetry(
        async () => {
            const response = await generateText({
                model: geminiFlashModel,
                temperature: 0,
                prompt: `${prompt}\n\nSEGMENTS:\n${JSON.stringify(batch, null, 2)}`,
                output: Output.array({
                    element: adLabelSchema,
                    name: 'ad_segment_labels',
                    description: 'One classification for every provided transcript segment',
                }),
            });

            return validateBatchLabels(batch, response.output);
        },
        'classify ad segments',
        2,
    ))));

    const finalLabels = reconcileAdLabels(segments, results.flat());

    const adCount = finalLabels.filter(l => l.label === 'ad').length;
    const interactionCount = finalLabels.filter(l => l.label === 'interaction_reminder').length;
    console.log(chalk.green(`  AI labeled ${adCount}/${segments.length} segments as ads, ${interactionCount}/${segments.length} as interaction reminders`));

    return finalLabels;
}
