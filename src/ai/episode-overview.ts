import path from 'path';
import { generateText } from 'ai';

import { geminiFlashModel } from '../clients';
import { PROMPTS_DIR } from '../constants';
import { parseEpisodeOverview, type EpisodeOverviewSection } from '../podcast-mirror/episode-description';
import type { TranscriptSegment } from '../types';
import { withRetry } from '../utils/retry';

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'episode-overview.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Episode overview prompt not found at: ${promptPath}`);
    }
    return file.text();
}

export async function generateEpisodeOverview(options: {
    title: string;
    sourceDescription: string;
    segments: TranscriptSegment[];
}): Promise<EpisodeOverviewSection[]> {
    if (options.segments.length === 0) {
        throw new Error('Cannot generate an episode overview without content segments');
    }

    const prompt = await loadPrompt();
    return withRetry(
        async () => {
            const response = await generateText({
                model: geminiFlashModel,
                prompt: `${prompt}\n\nEPISODE TITLE:\n${options.title}\n\nSOURCE DESCRIPTION:\n${options.sourceDescription.slice(0, 30_000) || '(none)'}\n\nAD-FREE TRANSCRIPT SEGMENTS:\n${JSON.stringify(options.segments, null, 2)}`,
            });
            const sections = parseEpisodeOverview(response.text, new Set(options.segments.map(segment => segment.index)));
            if (sections[0].startSegmentIndex !== options.segments[0].index) {
                throw new Error('Episode overview does not start at the first content segment');
            }
            return sections;
        },
        'generate episode overview',
        2,
    );
}
