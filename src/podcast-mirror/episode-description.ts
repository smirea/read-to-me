export interface EpisodeOverviewSection {
    startSegmentIndex: number;
    summary: string;
}

function stripCodeFences(text: string): string {
    return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

export function parseEpisodeOverview(text: string, validSegmentIndexes: Set<number>): EpisodeOverviewSection[] {
    const raw = stripCodeFences(text);
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        const start = raw.indexOf('[');
        const end = raw.lastIndexOf(']');
        if (start < 0 || end <= start) {
            throw new Error(`Invalid episode-overview JSON response: ${raw.slice(0, 300)}`);
        }
        parsed = JSON.parse(raw.slice(start, end + 1));
    }

    if (!Array.isArray(parsed)) {
        throw new Error('Episode overview response is not an array');
    }

    const sections = parsed
        .filter((section): section is Record<string, unknown> => Boolean(section) && typeof section === 'object')
        .filter(section => typeof section.startSegmentIndex === 'number' && validSegmentIndexes.has(section.startSegmentIndex))
        .filter(section => typeof section.summary === 'string' && section.summary.trim().length > 0)
        .map(section => ({
            startSegmentIndex: section.startSegmentIndex as number,
            summary: normalizeSentence(section.summary as string),
        }))
        .sort((a, b) => a.startSegmentIndex - b.startSegmentIndex);

    const deduped = sections.filter((section, index) => index === 0 || section.startSegmentIndex !== sections[index - 1].startSegmentIndex);
    if (deduped.length === 0) {
        throw new Error('Episode overview did not contain any valid sections');
    }

    return deduped;
}

export function formatEpisodeDescription(sections: Array<{ startMs: number; summary: string }>): string {
    return sections
        .map(section => `${formatTimestamp(section.startMs)} — ${normalizeSentence(section.summary)}`)
        .join('\n\n');
}

function normalizeSentence(value: string): string {
    const sentence = value.replace(/\s+/g, ' ').trim();
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
