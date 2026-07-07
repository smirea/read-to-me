import { XMLParser } from 'fast-xml-parser';

import { GCS_BASE_URL } from '../constants';
import type { ChapterImageData, EpisodeData, RssFeedOptions } from '../types';
import { fetchWithUA } from '../utils/fetch';
import { formatChapterTime, formatMs, parseTimeToMs } from '../utils/time';
import { escapeXml } from './shared';

type ExistingEpisode = {
    episodeNumber: number;
    slug: string;
};

export function generateRssFeed(options: RssFeedOptions): string {
    const pubDate = new Date().toUTCString();
    const durationFormatted = formatMs(options.durationMs);
    const pscChapters = renderPscChapters(options.chapters);
    const podcastChaptersUrl = options.chaptersJsonUrl || options.audioUrl.replace(/\.[^/.]+$/, '-chapters.json');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
    xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
    xmlns:podcast="https://podcastindex.org/namespace/1.0"
    xmlns:psc="http://podlove.org/simple-chapters">
    <channel>
        <title>${escapeXml(options.title)}</title>
        <link>${escapeXml(options.sourceUrl)}</link>
        <description>${escapeXml(options.summary)}</description>
        <language>en</language>
        <itunes:author>${escapeXml(options.author)}</itunes:author>
        <itunes:summary>${escapeXml(options.summary)}</itunes:summary>
        <itunes:image href="${escapeXml(options.thumbnailUrl)}" />
        <itunes:category text="Technology" />
        <itunes:explicit>false</itunes:explicit>
        <image>
            <url>${escapeXml(options.thumbnailUrl)}</url>
            <title>${escapeXml(options.title)}</title>
            <link>${escapeXml(options.sourceUrl)}</link>
        </image>
        <item>
            <title>${escapeXml(options.title)}</title>
            <description>${escapeXml(options.summary)}</description>
            <link>${escapeXml(options.sourceUrl)}</link>
            <guid isPermaLink="false">${escapeXml(options.audioUrl)}</guid>
            <pubDate>${pubDate}</pubDate>
            <enclosure url="${escapeXml(options.audioUrl)}" length="${options.audioSizeBytes}" type="audio/mp4" />
            <itunes:duration>${durationFormatted}</itunes:duration>
            <itunes:summary>${escapeXml(options.summary)}</itunes:summary>
            <itunes:image href="${escapeXml(options.thumbnailUrl)}" />
            <psc:chapters version="1.2">
${pscChapters}
            </psc:chapters>
            <podcast:chapters url="${escapeXml(podcastChaptersUrl)}" type="application/json+chapters" />
        </item>
    </channel>
</rss>`;
}

export function generateJsonChapters(
    chapters: Array<{
        title: string;
        startMs: number;
        imageUrl?: string;
        pageUrl?: string;
    }>,
    sourceUrl?: string,
) {
    return {
        version: '1.2.0',
        title: 'Chapters',
        ...(sourceUrl ? { podcast: sourceUrl } : {}),
        chapters: chapters
            .filter(chapter => Number.isFinite(chapter.startMs))
            .sort((a, b) => a.startMs - b.startMs)
            .map(chapter => ({
                startTime: Math.round(Math.max(0, chapter.startMs)) / 1000,
                title: chapter.title,
                ...(chapter.imageUrl ? { img: chapter.imageUrl } : {}),
                ...(chapter.pageUrl ? { url: chapter.pageUrl } : {}),
            })),
    };
}

export async function updateMasterFeed(masterFeedUrl: string, newEpisode: EpisodeData): Promise<string> {
    const existingEpisodes = await getEpisodesFromFeed(masterFeedUrl);
    const episodes = [
        newEpisode,
        ...existingEpisodes.filter(episode =>
            episode.audioUrl !== newEpisode.audioUrl
            && episode.sourceUrl !== newEpisode.sourceUrl
        ),
    ];

    return generateMasterFeed(episodes);
}

export async function getNextEpisodeNumber(masterFeedUrl: string): Promise<number> {
    const episodes = await getEpisodesFromFeed(masterFeedUrl);
    const maxEpisode = episodes.reduce((max, episode) => {
        const parsed = parseEpisodeFromAudioUrl(episode.audioUrl);
        return Math.max(max, parsed?.episodeNumber ?? 0);
    }, 0);
    return maxEpisode + 1;
}

export async function findExistingEpisode(masterFeedUrl: string, sourceUrl: string): Promise<ExistingEpisode | null> {
    const episodes = await getEpisodesFromFeed(masterFeedUrl);
    const episode = episodes.find(episode => episode.sourceUrl === sourceUrl);
    if (!episode) return null;
    return parseEpisodeFromAudioUrl(episode.audioUrl);
}

export function buildDescriptionWithImages(
    summary: string,
    chapters: Array<{
        title: string;
        startMs: number;
        images: ChapterImageData[];
    }>,
): string {
    const imageLines = chapters.flatMap(chapter =>
        chapter.images.map(image => [
            `${chapter.title} (${formatMs(chapter.startMs)})`,
            image.description,
            image.gcsUrl,
        ].join('\n'))
    );

    if (imageLines.length === 0) return summary;
    return `${summary}\n\nImages referenced in this episode:\n\n${imageLines.join('\n\n')}`;
}

async function getEpisodesFromFeed(feedUrl: string): Promise<EpisodeData[]> {
    try {
        const response = await fetchWithUA(`${feedUrl}?fresh=${Date.now()}`);
        if (!response.ok) return [];
        return parseEpisodesFromFeed(await response.text());
    } catch {
        return [];
    }
}

function parseEpisodesFromFeed(feedXml: string): EpisodeData[] {
    const parsed = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: false,
        isArray: name => name === 'item' || name === 'psc:chapter',
    }).parse(feedXml);
    const items = parsed?.rss?.channel?.item ?? [];

    return items.map((item: any) => {
        const enclosure = item.enclosure ?? {};
        const chapters = (item['psc:chapters']?.['psc:chapter'] ?? []).map((chapter: any) => ({
            title: chapter['@_title'] || '',
            startMs: parseTimeToMs(chapter['@_start'] || '0:00:00'),
        }));
        const thumbnailUrl = item['itunes:image']?.['@_href'] || '';

        return {
            title: textValue(item.title),
            author: textValue(item['itunes:author']) || 'Read To Me',
            summary: textValue(item.description),
            sourceUrl: textValue(item.link),
            audioUrl: enclosure['@_url'] || '',
            thumbnailUrl,
            audioSizeBytes: Number.parseInt(enclosure['@_length'] || '0', 10),
            durationMs: parseTimeToMs(textValue(item['itunes:duration'])),
            pubDate: textValue(item.pubDate),
            chapters,
        };
    });
}

function generateMasterFeed(episodes: EpisodeData[]): string {
    const itemsXml = episodes.map(episode => {
        const pscChapters = renderPscChapters(episode.chapters);

        return `        <item>
            <title>${escapeXml(episode.title)}</title>
            <description>${escapeXml(episode.summary)}</description>
            <link>${escapeXml(episode.sourceUrl)}</link>
            <guid isPermaLink="false">${escapeXml(episode.audioUrl)}</guid>
            <pubDate>${episode.pubDate}</pubDate>
            <enclosure url="${escapeXml(episode.audioUrl)}" length="${episode.audioSizeBytes}" type="audio/mp4" />
            <itunes:duration>${formatMs(episode.durationMs)}</itunes:duration>
            <itunes:author>${escapeXml(episode.author)}</itunes:author>
            <itunes:summary>${escapeXml(episode.summary)}</itunes:summary>
            <itunes:image href="${escapeXml(episode.thumbnailUrl)}" />
            <psc:chapters version="1.2">
${pscChapters}
            </psc:chapters>
        </item>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
    xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
    xmlns:podcast="https://podcastindex.org/namespace/1.0"
    xmlns:psc="http://podlove.org/simple-chapters">
    <channel>
        <title>Read To Me</title>
        <link>${GCS_BASE_URL}/read-to-me/</link>
        <description>Articles converted to audio with AI-powered narration</description>
        <language>en</language>
        <itunes:author>Read To Me</itunes:author>
        <itunes:summary>Articles converted to audio with AI-powered narration</itunes:summary>
        <itunes:image href="${GCS_BASE_URL}/read-to-me/cover.png" />
        <itunes:category text="Technology" />
        <itunes:explicit>false</itunes:explicit>
        <image>
            <url>${GCS_BASE_URL}/read-to-me/cover.png</url>
            <title>Read To Me</title>
            <link>${GCS_BASE_URL}/read-to-me/</link>
        </image>
${itemsXml}
    </channel>
</rss>`;
}

function renderPscChapters(chapters: Array<{ title: string; startMs: number }>): string {
    return chapters.map(chapter =>
        `            <psc:chapter start="${formatChapterTime(chapter.startMs)}" title="${escapeXml(chapter.title)}" />`
    ).join('\n');
}

function parseEpisodeFromAudioUrl(audioUrl: string): ExistingEpisode | null {
    try {
        const url = new URL(audioUrl);
        const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-2) ?? '');
        const episodeNumber = Number.parseInt(slug.split('_')[0] ?? '', 10);
        if (!slug || !Number.isFinite(episodeNumber)) return null;
        return { episodeNumber, slug };
    } catch {
        return null;
    }
}

function textValue(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && '#text' in value) return String(value['#text'] ?? '');
    return '';
}
