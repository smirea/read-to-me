import chalk from 'chalk';
import path from 'path';
import pLimit from 'p-limit';
import { generateText } from 'ai';
import { geminiFlashModel } from '../clients';
import { PROMPTS_DIR, GEMINI_CONCURRENCY } from '../constants';
import { withRetry } from '../utils/retry';
import type { AdSegmentLabel, TranscriptSegment } from '../types';

const aiLimit = pLimit(GEMINI_CONCURRENCY);

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'ad-detection.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Ad detection prompt not found at: ${promptPath}`);
    }
    return file.text();
}

function chunkSegments(segments: TranscriptSegment[], maxChars = 12000, maxSegments = 40): TranscriptSegment[][] {
    const chunks: TranscriptSegment[][] = [];
    let current: TranscriptSegment[] = [];
    let currentChars = 0;

    for (const segment of segments) {
        const serialized = JSON.stringify(segment);
        const nextChars = currentChars + serialized.length;
        if (current.length >= maxSegments || nextChars > maxChars) {
            if (current.length > 0) chunks.push(current);
            current = [segment];
            currentChars = serialized.length;
        } else {
            current.push(segment);
            currentChars = nextChars;
        }
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

function stripCodeFences(text: string): string {
    return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

export async function classifyAdSegments(segments: TranscriptSegment[]): Promise<AdSegmentLabel[]> {
    if (segments.length === 0) return [];

    const prompt = await loadPrompt();
    const batches = chunkSegments(segments);

    const results = await Promise.all(batches.map(batch => aiLimit(async () => {
        const response = await withRetry(
            async () => generateText({
                model: geminiFlashModel,
                prompt: `${prompt}\n\nSEGMENTS:\n${JSON.stringify(batch, null, 2)}`,
            }),
            'classify ad segments'
        );

        const raw = stripCodeFences(response.text);
        const parsed = JSON.parse(raw) as AdSegmentLabel[];
        return parsed;
    })));

    const flattened = results.flat();
    const labelMap = new Map<number, AdSegmentLabel>();
    for (const label of flattened) {
        if (typeof label?.index === 'number' && (label.label === 'ad' || label.label === 'content')) {
            labelMap.set(label.index, label);
        }
    }

    const finalLabels = segments.map(segment => {
        const label = labelMap.get(segment.index);
        if (!label) {
            return { index: segment.index, label: 'content' } as AdSegmentLabel;
        }
        return label;
    });

    const adCount = finalLabels.filter(l => l.label === 'ad').length;
    console.log(chalk.green(`  AI labeled ${adCount}/${segments.length} segments as ads`));

    return finalLabels;
}
