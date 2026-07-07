import type { ChapterMetadata, ExtractedContent } from '../types';
import { escapeMetadata } from './shared';

export {
    buildDescriptionWithImages,
    findExistingEpisode,
    generateJsonChapters,
    generateRssFeed,
    getNextEpisodeNumber,
    updateMasterFeed,
} from './rss';

export function generateMarkdown(content: ExtractedContent, sourceUrl: string): string {
    let markdown = `# ${content.title}\n\n`;

    if (content.byline) {
        markdown += `*By ${content.byline}*\n\n`;
    }

    markdown += `> Source: ${sourceUrl}\n\n---\n\n`;

    for (const chapter of content.chapters) {
        markdown += `## ${chapter.title}\n\n`;
        markdown += `${chapter.content.trim()}\n\n`;
    }

    return markdown;
}

export function generateFfmetadata(
    content: ExtractedContent,
    chapters: ChapterMetadata[],
    totalDurationMs: number,
    summary: string,
    narrator: string,
    sourceUrl: string,
): string {
    let metadata = `;FFMETADATA1\ntitle=${escapeMetadata(content.title)}\n`;
    if (content.byline) {
        metadata += `artist=${escapeMetadata(content.byline)}\n`;
    }

    const fullDescription = `${summary} Source: ${sourceUrl}`;
    metadata += `album=Read To Me\n`;
    metadata += `composer=${escapeMetadata(narrator)}\n`;
    metadata += `description=${escapeMetadata(fullDescription)}\n`;
    metadata += `comment=${escapeMetadata(fullDescription)}\n`;
    metadata += `genre=Podcast\n\n`;

    for (const chapter of chapters) {
        const endMs = chapter.index < chapters.length
            ? chapters[chapter.index].startMs
            : totalDurationMs;

        metadata += `[CHAPTER]\n`;
        metadata += `TIMEBASE=1/1000\n`;
        metadata += `START=${chapter.startMs}\n`;
        metadata += `END=${endMs}\n`;
        metadata += `title=${escapeMetadata(chapter.title)}\n\n`;
    }

    return metadata;
}
