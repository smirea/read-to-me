#!/usr/bin/env bun
import chalk from 'chalk';
import path from 'path';
import { mkdir, stat, unlink, writeFile, copyFile, readFile } from 'fs/promises';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import pLimit from 'p-limit';
import { SpeechClient } from '@google-cloud/speech';

import { createScript, style } from './utils/createScript';
import { fetchWithUA } from './utils/fetch';
import { formatMs, formatChapterTime, parseTimeToMs } from './utils/time';
import { withRetry } from './utils/retry';
import { FETCH_CONCURRENCY, GCS_BASE_URL, GCS_BUCKET, TTS_SAMPLE_RATE } from './constants';
import { uploadToGCS } from './upload';
import { generateJsonChapters } from './output';
import { classifyAdSegments } from './ai/ad-detection';
import { generateEpisodeOverview } from './ai/episode-overview';
import { resolveVoice, DEFAULT_VOICE, VOICE_NAMES, ENGLISH_DIALECTS, type EnglishDialect } from './voice';
import { gcsClient, ttsClient } from './clients';
import { applyMirroredItemFields, buildMergedMirrorItems, computeEpisodeSlug, extractEpisodeSlug, slugify } from './podcast-mirror/feed-utils';
import { isInteractionReminderText } from './podcast-mirror/interaction-reminder';
import { prefixMirrorText, renderMirrorArtwork } from './podcast-mirror/artwork';
import { formatEpisodeDescription } from './podcast-mirror/episode-description';
import { detectSponsorKeywordRanges } from './podcast-mirror/sponsor-detection';
import type { TranscriptSegment, TranscriptWord } from './types';

const argv = yargs(hideBin(process.argv))
    .scriptName('podcast-mirror')
    .usage('$0 <feedUrl>', 'Mirror a podcast feed with ad reads spliced to the end', yargs => {
        return yargs.positional('feedUrl', {
            describe: 'URL of the podcast RSS feed',
            type: 'string',
            demandOption: true,
        });
    })
    .option('output', {
        alias: 'o',
        describe: 'Output directory path',
        type: 'string',
    })
    .option('skip-upload', {
        describe: 'Skip uploading to GCS bucket (for testing)',
        type: 'boolean',
        default: false,
    })
    .option('first', {
        describe: 'Only process the first N episodes in the feed order',
        type: 'number',
    })
    .option('last', {
        describe: 'Only process the last N episodes in the feed order',
        type: 'number',
    })
    .option('limit', {
        describe: 'Only process the newest N episodes',
        type: 'number',
    })
    .option('episode', {
        describe: 'Episode title fuzzy search (can be repeated)',
        type: 'string',
        array: true,
    })
    .option('voice', {
        alias: 'v',
        describe: 'Voice to use for injected ad announcement',
        choices: [...VOICE_NAMES, 'random', 'random-male', 'random-female'] as const,
        default: DEFAULT_VOICE,
    })
    .option('dialect', {
        alias: 'd',
        describe: 'English dialect to use for injected ad announcement',
        choices: ENGLISH_DIALECTS,
        default: 'en-US' satisfies EnglishDialect,
    })
    .option('language', {
        describe: 'Language code for transcription',
        type: 'string',
        default: 'en-US',
    })
    .strict()
    .help()
    .parseSync();

const fetchLimit = pLimit(FETCH_CONCURRENCY);

const SEGMENT_TARGET_SEC = 30;
const SEGMENT_MAX_SEC = 45;
const SEGMENT_MIN_SEC = 10;
const AD_PADDING_SEC = 0.4;

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function getText(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && '#text' in value) return String(value['#text'] ?? '');
    return '';
}

function setText(node: any, text: string): any {
    if (node && typeof node === 'object' && '#text' in node) {
        return { ...node, '#text': text };
    }
    return text;
}

function prefixTextNode(node: any): any {
    const text = getText(node);
    if (!text) return node;
    return setText(node, prefixMirrorText(text));
}

function getSourceEpisodeDescription(item: any): string {
    const candidates = [
        getText(item['content:encoded']),
        getText(item['itunes:summary']),
        getText(item.description),
    ].filter(Boolean);
    return candidates.sort((a, b) => b.length - a.length)[0] ?? '';
}

function setEpisodeDescription(item: any, description: string): void {
    item.description = setText(item.description, description);
    item['itunes:summary'] = setText(item['itunes:summary'], description);
    if (item['content:encoded']) {
        item['content:encoded'] = setText(item['content:encoded'], description);
    }
}

function parseChapterStart(start: string): number {
    return parseTimeToMs(start) / 1000;
}

function normalizeTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchesEpisodeQuery(title: string, query: string): boolean {
    const normalizedTitle = normalizeTitle(title);
    const normalizedQuery = normalizeTitle(query);
    if (!normalizedQuery) return false;
    if (normalizedTitle.includes(normalizedQuery)) return true;
    const tokens = normalizedQuery.split(' ').filter(Boolean);
    return tokens.every(token => normalizedTitle.includes(token));
}

function guessAudioFormat(enclosureUrl: string, enclosureType?: string): { ext: string; mime: string; codec: string } {
    const lowerType = enclosureType?.toLowerCase() ?? '';
    let ext = '';
    try {
        const url = new URL(enclosureUrl);
        ext = path.extname(url.pathname).replace('.', '').toLowerCase();
    } catch {
        ext = path.extname(enclosureUrl).replace('.', '').toLowerCase();
    }

    if (lowerType.includes('mpeg') || ext === 'mp3') {
        return { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame' };
    }
    if (lowerType.includes('mp4') || lowerType.includes('aac') || ext === 'm4a' || ext === 'mp4') {
        return { ext: 'm4a', mime: 'audio/mp4', codec: 'aac' };
    }

    return { ext: 'm4a', mime: 'audio/mp4', codec: 'aac' };
}

async function fetchText(url: string): Promise<string> {
    const response = await fetchWithUA(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response.text();
}

async function fetchExistingMirrorItems(feedUrl: string, gcsRoot: string): Promise<{
    itemsBySlug: Map<string, any>;
    slugsInOrder: string[];
}> {
    try {
        const feedXml = await fetchText(feedUrl);
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            removeNSPrefix: false,
            isArray: (name) => name === 'item' || name === 'psc:chapter' || name === 'atom:link',
        });
        const parsed = parser.parse(feedXml) as any;
        const channel = parsed?.rss?.channel;
        const items = ensureArray(channel?.item);

        const itemsBySlug = new Map<string, any>();
        const slugsInOrder: string[] = [];

        for (const item of items) {
            const enclosureUrl = item?.enclosure?.['@_url'];
            if (typeof enclosureUrl !== 'string') continue;
            const slug = extractEpisodeSlug(enclosureUrl, gcsRoot);
            if (!slug) continue;
            itemsBySlug.set(slug, item);
            slugsInOrder.push(slug);
        }

        return { itemsBySlug, slugsInOrder };
    } catch {
        return { itemsBySlug: new Map(), slugsInOrder: [] };
    }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
    await mkdir(path.dirname(destPath), { recursive: true });
    const response = await fetchWithUA(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    const data = await response.arrayBuffer();
    await Bun.write(destPath, Buffer.from(data));
}

async function getAudioInfo(filePath: string): Promise<{ durationSec: number; sampleRate: number; channels: number; bitRate?: number }> {
    const result = await Bun.$`ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,channels,bit_rate -show_entries format=duration -of json ${filePath}`.quiet();
    if (result.exitCode !== 0) {
        throw new Error(`ffprobe failed for ${filePath}`);
    }
    const data = JSON.parse(result.stdout.toString()) as {
        streams?: Array<{ sample_rate?: string; channels?: number; bit_rate?: string }>;
        format?: { duration?: string };
    };
    const stream = data.streams?.[0] ?? {};
    return {
        durationSec: Number(data.format?.duration ?? 0),
        sampleRate: Number(stream.sample_rate ?? 44100),
        channels: Number(stream.channels ?? 2),
        bitRate: stream.bit_rate ? Number(stream.bit_rate) : undefined,
    };
}

async function transcribeAudioWithTimestamps(
    speechClient: SpeechClient,
    audioPath: string,
    gcsObjectPath: string,
    languageCode: string,
): Promise<TranscriptWord[]> {
    const flacPath = audioPath.replace(/\.[^/.]+$/, '.transcribe.flac');
    const ffmpegResult = await Bun.$`ffmpeg -y -i ${audioPath} -ac 1 -ar 16000 -c:a flac ${flacPath}`.quiet();
    if (ffmpegResult.exitCode !== 0) {
        throw new Error('Failed to create transcription FLAC');
    }

    await uploadToGCS(flacPath, `${GCS_BUCKET}/${gcsObjectPath}`, 'audio/flac');
    const gcsUri = `gs://${GCS_BUCKET}/${gcsObjectPath}`;

    const [operation] = await speechClient.longRunningRecognize({
        audio: { uri: gcsUri },
        config: {
            encoding: 'FLAC',
            sampleRateHertz: 16000,
            languageCode,
            enableWordTimeOffsets: true,
            enableAutomaticPunctuation: true,
        },
    });

    const operationName = (operation as { name?: string }).name;
    if (operationName) {
        console.log(chalk.gray(`  Speech operation: ${operationName}`));
    }

    const [response] = await withRetry(
        () => operation.promise(),
        'wait for speech operation',
        3,
    );

    const words: TranscriptWord[] = [];
    for (const result of response.results ?? []) {
        const alt = result.alternatives?.[0];
        for (const wordInfo of alt?.words ?? []) {
            const startSec = Number(wordInfo.startTime?.seconds ?? 0) + Number(wordInfo.startTime?.nanos ?? 0) / 1e9;
            const endSec = Number(wordInfo.endTime?.seconds ?? 0) + Number(wordInfo.endTime?.nanos ?? 0) / 1e9;
            if (!wordInfo.word) continue;
            words.push({ word: wordInfo.word, startSec, endSec });
        }
    }

    await gcsClient.bucket(GCS_BUCKET).file(gcsObjectPath).delete().catch(() => {});
    await unlink(flacPath).catch(() => {});

    return words;
}

async function ensureGoogleCredentials(): Promise<string> {
    const defaultPath = path.join(process.cwd(), 'gcp-key.json');
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultPath;
    const file = Bun.file(credentialsPath);
    if (!await file.exists()) {
        throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS or gcp-key.json');
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    }
    return credentialsPath;
}

function buildTranscriptSegments(words: TranscriptWord[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    let currentWords: string[] = [];
    let startSec = 0;
    let endSec = 0;

    const pushSegment = () => {
        if (currentWords.length === 0) return;
        const text = currentWords.join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
        if (!text) return;
        segments.push({ index: segments.length + 1, startSec, endSec, text });
        currentWords = [];
    };

    for (const word of words) {
        if (currentWords.length === 0) {
            startSec = word.startSec;
        }
        currentWords.push(word.word);
        endSec = word.endSec;

        const duration = endSec - startSec;
        const endsSentence = /[.!?]$/.test(word.word);

        if ((duration >= SEGMENT_TARGET_SEC && endsSentence) || duration >= SEGMENT_MAX_SEC) {
            pushSegment();
        }
    }

    if (currentWords.length > 0) {
        pushSegment();
    }

    const merged: TranscriptSegment[] = [];
    for (const segment of segments) {
        if (merged.length === 0) {
            merged.push({ ...segment, index: merged.length + 1 });
            continue;
        }
        const prev = merged[merged.length - 1];
        const prevDuration = prev.endSec - prev.startSec;
        if (prevDuration < SEGMENT_MIN_SEC) {
            prev.endSec = segment.endSec;
            prev.text = `${prev.text} ${segment.text}`.trim();
            continue;
        }
        merged.push({ ...segment, index: merged.length + 1 });
    }

    return merged.map((segment, index) => ({ ...segment, index: index + 1 }));
}

function mergeAdRanges(ranges: Array<{ startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number }> {
    if (ranges.length === 0) return [];
    const sorted = ranges
        .map(r => ({ startSec: Math.max(0, r.startSec), endSec: Math.max(0, r.endSec) }))
        .sort((a, b) => a.startSec - b.startSec);

    const merged: Array<{ startSec: number; endSec: number }> = [sorted[0]];
    for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (range.startSec <= last.endSec + 0.2) {
            last.endSec = Math.max(last.endSec, range.endSec);
        } else {
            merged.push(range);
        }
    }
    return merged;
}

function invertRanges(
    totalDurationSec: number,
    removedRanges: Array<{ startSec: number; endSec: number }>
): Array<{ startSec: number; endSec: number }> {
    const keep: Array<{ startSec: number; endSec: number }> = [];
    let cursor = 0;

    for (const range of removedRanges) {
        if (range.startSec > cursor) {
            keep.push({ startSec: cursor, endSec: range.startSec });
        }
        cursor = Math.max(cursor, range.endSec);
    }

    if (cursor < totalDurationSec) {
        keep.push({ startSec: cursor, endSec: totalDurationSec });
    }

    return keep.filter(r => r.endSec - r.startSec > 0.1);
}

function adjustChapterStart(originalSec: number, removedRanges: Array<{ startSec: number; endSec: number }>): number {
    let shift = 0;
    for (const range of removedRanges) {
        if (range.endSec <= originalSec) {
            shift += range.endSec - range.startSec;
        } else if (range.startSec < originalSec) {
            shift += originalSec - range.startSec;
            break;
        } else {
            break;
        }
    }
    return Math.max(0, originalSec - shift);
}

async function extractSegment(
    inputPath: string,
    segment: { startSec: number; endSec: number },
    outputPath: string,
    sampleRate: number,
    channels: number,
): Promise<void> {
    const duration = Math.max(0, segment.endSec - segment.startSec);
    if (duration <= 0.1) return;
    const result = await Bun.$`ffmpeg -y -i ${inputPath} -ss ${segment.startSec} -t ${duration} -ar ${sampleRate} -ac ${channels} -c:a pcm_s16le ${outputPath}`.quiet();
    if (result.exitCode !== 0) {
        throw new Error(`Failed to extract segment ${segment.startSec}-${segment.endSec}`);
    }
}

async function synthesizeAnnouncement(
    text: string,
    outputPath: string,
    sampleRate: number,
    channels: number,
    voice: string,
    dialect: EnglishDialect,
): Promise<void> {
    const [response] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: {
            languageCode: dialect,
            name: `${dialect}-Chirp3-HD-${voice}`,
        },
        audioConfig: {
            audioEncoding: 'LINEAR16',
            sampleRateHertz: TTS_SAMPLE_RATE,
            speakingRate: 0.9,
        },
    });

    if (!response.audioContent) {
        throw new Error('TTS did not return audio content');
    }

    const pcmPath = outputPath.replace(/\.wav$/, '.pcm');
    await Bun.write(pcmPath, Buffer.from(response.audioContent as Uint8Array));

    const result = await Bun.$`ffmpeg -y -f s16le -ar ${TTS_SAMPLE_RATE} -ac 1 -i ${pcmPath} -ar ${sampleRate} -ac ${channels} -c:a pcm_s16le ${outputPath}`.quiet();
    if (result.exitCode !== 0) {
        throw new Error('Failed to convert announcement audio');
    }

    await unlink(pcmPath).catch(() => {});
}

async function concatSegments(
    segmentPaths: string[],
    outputPath: string,
    codec: string,
    sampleRate: number,
    channels: number,
    bitRateKbps: number,
): Promise<void> {
    const listPath = outputPath.replace(/\.[^/.]+$/, '.concat.txt');
    const listContent = segmentPaths.map(segment => `file '${segment.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, listContent, 'utf-8');

    let result;
    if (codec === 'aac') {
        result = await Bun.$`ffmpeg -y -f concat -safe 0 -i ${listPath} -ar ${sampleRate} -ac ${channels} -b:a ${bitRateKbps}k -c:a ${codec} -movflags +faststart ${outputPath}`.quiet();
    } else {
        result = await Bun.$`ffmpeg -y -f concat -safe 0 -i ${listPath} -ar ${sampleRate} -ac ${channels} -b:a ${bitRateKbps}k -c:a ${codec} ${outputPath}`.quiet();
    }
    if (result.exitCode !== 0) {
        throw new Error('Failed to concatenate segments');
    }
}

function buildChapters(
    originalChapters: Array<{ title: string; startSec: number }>,
    removedRanges: Array<{ startSec: number; endSec: number }>,
    mainDurationSec: number,
    includeAds: boolean,
    adCount: number,
): Array<{ title: string; startMs: number }> {
    const adjusted = originalChapters
        .map(chapter => ({
            title: chapter.title || 'Chapter',
            startSec: adjustChapterStart(chapter.startSec, removedRanges),
        }))
        .filter(chapter => chapter.startSec < mainDurationSec)
        .sort((a, b) => a.startSec - b.startSec);

    const deduped: Array<{ title: string; startSec: number }> = [];
    for (const chapter of adjusted) {
        const last = deduped[deduped.length - 1];
        if (!last || Math.abs(last.startSec - chapter.startSec) > 0.5) {
            deduped.push(chapter);
        }
    }

    if (deduped.length === 0) {
        deduped.push({ title: 'Episode', startSec: 0 });
    }

    if (includeAds) {
        const title = adCount === 1 ? 'Spliced Ad Read' : `Spliced Ad Reads (${adCount})`;
        deduped.push({ title, startSec: mainDurationSec });
    }

    return deduped.map(chapter => ({ title: chapter.title, startMs: Math.round(chapter.startSec * 1000) }));
}

function updateGuid(node: any, value: string): any {
    if (node && typeof node === 'object') {
        return { ...node, '#text': value };
    }
    return value;
}

function updateAtomSelfLink(channel: any, feedUrl: string) {
    const atomLinks = ensureArray(channel['atom:link']);
    let updated = false;
    const updatedLinks = atomLinks.map(link => {
        if (link?.['@_rel'] === 'self') {
            updated = true;
            return { ...link, '@_href': feedUrl };
        }
        return link;
    });
    if (updated) {
        channel['atom:link'] = updatedLinks;
    }
}

function getItunesImageUrl(value: any): string {
    const image = Array.isArray(value) ? value[0] : value;
    const href = image?.['@_href'];
    return typeof href === 'string' ? href : '';
}

function getArtworkUrl(node: any): string {
    return getItunesImageUrl(node?.['itunes:image']) || getText(node?.image?.url);
}

function setItunesImageUrl(node: any, url: string): any {
    const current = Array.isArray(node) ? node[0] : node;
    if (current && typeof current === 'object') {
        return { ...current, '@_href': url };
    }
    return { '@_href': url };
}

function setChannelArtwork(channel: any, artworkUrl: string, title: string): void {
    channel['itunes:image'] = setItunesImageUrl(channel['itunes:image'], artworkUrl);
    channel.image ??= {};
    channel.image.url = setText(channel.image.url, artworkUrl);
    channel.image.title = setText(channel.image.title, title);
    if (!channel.image.link && channel.link) {
        channel.image.link = channel.link;
    }
}

function setEpisodeArtwork(item: any, artworkUrl: string): void {
    item['itunes:image'] = setItunesImageUrl(item['itunes:image'], artworkUrl);
    if (item.image?.url) {
        item.image.url = setText(item.image.url, artworkUrl);
    }
}

function brandEpisodeTitle(item: any): void {
    item.title = prefixTextNode(item.title);
    if (item['itunes:title']) {
        item['itunes:title'] = prefixTextNode(item['itunes:title']);
    }
}

async function renderAndUploadArtwork(
    sourceUrl: string,
    outputPath: string,
    gcsObjectPath: string,
    publicUrl: string,
    skipUpload: boolean,
): Promise<string | null> {
    try {
        await renderMirrorArtwork(sourceUrl, outputPath);
        if (!skipUpload) {
            await uploadToGCS(outputPath, `${GCS_BUCKET}/${gcsObjectPath}`, 'image/png');
        }
        return publicUrl;
    } catch (error) {
        console.log(chalk.yellow(`  ⚠ Could not brand artwork: ${error instanceof Error ? error.message : String(error)}`));
        return null;
    }
}

async function brandChannelArtwork(channel: any, baseOutputDir: string, gcsRoot: string, gcsFeedUrl: string, skipUpload: boolean): Promise<void> {
    const sourceUrl = getArtworkUrl(channel);
    if (!sourceUrl) return;

    const artworkPath = path.join(baseOutputDir, '_artwork', 'channel.png');
    const gcsObjectPath = `${gcsRoot}/_artwork/channel.png`;
    const artworkUrl = `${GCS_BASE_URL}/${gcsObjectPath}`;
    const uploadedUrl = await renderAndUploadArtwork(sourceUrl, artworkPath, gcsObjectPath, artworkUrl, skipUpload);
    if (!uploadedUrl) return;

    setChannelArtwork(channel, uploadedUrl, getText(channel.title) || 'Podcast');
    updateAtomSelfLink(channel, gcsFeedUrl);
}

async function brandEpisodeArtwork(item: any, episodeDir: string, gcsEpisodePath: string, episodeSlug: string, skipUpload: boolean): Promise<void> {
    const sourceUrl = getArtworkUrl(item);
    if (!sourceUrl) return;

    const artworkPath = path.join(episodeDir, `${episodeSlug}-artwork.png`);
    const gcsObjectPath = `${gcsEpisodePath}/${episodeSlug}-artwork.png`;
    const artworkUrl = `${GCS_BASE_URL}/${gcsObjectPath}`;
    const uploadedUrl = await renderAndUploadArtwork(sourceUrl, artworkPath, gcsObjectPath, artworkUrl, skipUpload);
    if (!uploadedUrl) return;

    setEpisodeArtwork(item, uploadedUrl);
}

async function readExistingChapters(chaptersJsonPath: string): Promise<Array<{ title: string; startMs: number }> | null> {
    try {
        const raw = await readFile(chaptersJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { chapters?: Array<{ title?: string; startTime?: number }> };
        const chapters = parsed.chapters
            ?.filter(chapter => typeof chapter.startTime === 'number')
            .map(chapter => ({
                title: chapter.title || 'Chapter',
                startMs: Math.round((chapter.startTime ?? 0) * 1000),
            }));

        return chapters && chapters.length > 0 ? chapters : null;
    } catch {
        return null;
    }
}

async function applyLocalOutputFields(options: {
    item: any;
    outputAudioPath: string;
    chaptersJsonPath: string;
    episodeDescriptionPath: string;
    gcsEpisodePath: string;
    episodeSlug: string;
    ext: string;
    mime: string;
}): Promise<{ size: number }> {
    const outputInfo = await getAudioInfo(options.outputAudioPath);
    const outputStats = await stat(options.outputAudioPath);
    const audioUrl = `${GCS_BASE_URL}/${options.gcsEpisodePath}/${options.episodeSlug}.${options.ext}`;
    const chaptersJsonUrl = `${GCS_BASE_URL}/${options.gcsEpisodePath}/${options.episodeSlug}-chapters.json`;
    const existingChapters = await readExistingChapters(options.chaptersJsonPath);
    const episodeDescription = await readFile(options.episodeDescriptionPath, 'utf-8');
    const chapters = existingChapters ?? [{ title: 'Episode', startMs: 0 }];
    if (!existingChapters) {
        await writeFile(options.chaptersJsonPath, JSON.stringify(generateJsonChapters(chapters, getText(options.item.link)), null, 2), 'utf-8');
    }

    options.item.enclosure = {
        ...options.item.enclosure,
        '@_url': audioUrl,
        '@_length': String(outputStats.size),
        '@_type': options.mime,
    };

    options.item.guid = updateGuid(options.item.guid, audioUrl);
    setEpisodeDescription(options.item, episodeDescription.trim());
    options.item['itunes:duration'] = setText(options.item['itunes:duration'], formatMs(Math.round(outputInfo.durationSec * 1000)));
    options.item['psc:chapters'] = {
        '@_version': '1.2',
        'psc:chapter': chapters.map(chapter => ({
            '@_start': formatChapterTime(chapter.startMs),
            '@_title': chapter.title,
        })),
    };
    options.item['podcast:chapters'] = {
        '@_url': chaptersJsonUrl,
        '@_type': 'application/json+chapters',
    };

    return { size: outputStats.size };
}

void createScript(async () => {
    const feedUrl = argv.feedUrl as string;
    const outputDir = argv.output ? path.resolve(argv.output) : null;
    const skipUpload = argv['skip-upload'];
    const limit = typeof argv.limit === 'number' && argv.limit > 0 ? argv.limit : null;
    const first = typeof argv.first === 'number' && argv.first > 0 ? argv.first : null;
    const last = typeof argv.last === 'number' && argv.last > 0 ? argv.last : null;
    const episodeQueries = (argv.episode as string[] | undefined)?.filter(Boolean) ?? [];
    const voice = resolveVoice(argv.voice);
    const dialect = argv.dialect as EnglishDialect;
    const languageCode = argv.language as string;

    if (first && last) {
        throw new Error('Use only one of --first or --last');
    }
    if (limit && (first || last)) {
        throw new Error('Use --limit or --first/--last, not both');
    }

    await ensureGoogleCredentials();
    const speechClient = new SpeechClient();

    console.log(style.header('Podcast Mirror'));
    console.log('Configuration:');
    console.log(`  Feed URL: ${feedUrl}`);
    console.log(`  Voice: ${dialect}-Chirp3-HD-${voice}`);
    console.log(`  Transcription language: ${languageCode}`);
    console.log(`  Output: ${outputDir || '(auto)'}`);
    console.log(`  Upload: ${skipUpload ? 'disabled' : 'enabled'}`);
    if (limit) console.log(`  Episode limit: ${limit}`);
    if (first) console.log(`  First episodes: ${first}`);
    if (last) console.log(`  Last episodes: ${last}`);
    if (episodeQueries.length > 0) console.log(`  Episode queries: ${episodeQueries.join(', ')}`);
    console.log();

    const projectId = await speechClient.getProjectId();
    console.log(`  GCP Project: ${projectId}`);
    console.log();

    const feedXml = await fetchText(feedUrl);
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: false,
        isArray: (name) => name === 'item' || name === 'psc:chapter' || name === 'atom:link',
    });
    const parsed = parser.parse(feedXml) as any;
    const channel = parsed?.rss?.channel;
    if (!channel) {
        throw new Error('Invalid RSS feed: missing channel');
    }

    parsed.rss['@_xmlns:psc'] ??= 'http://podlove.org/simple-chapters';
    parsed.rss['@_xmlns:podcast'] ??= 'https://podcastindex.org/namespace/1.0';

    const originalTitle = getText(channel.title) || 'Podcast';
    const mirrorTitle = prefixMirrorText(originalTitle);
    const mirrorSlug = slugify(`R2M: ${originalTitle}`, 80) || 'r2m-podcast';
    const gcsRoot = mirrorSlug;
    const gcsFeedUrl = `${GCS_BASE_URL}/${gcsRoot}/feed.xml`;

    channel.title = setText(channel.title, mirrorTitle);
    if (channel['itunes:title']) {
        channel['itunes:title'] = setText(channel['itunes:title'], mirrorTitle);
    }
    updateAtomSelfLink(channel, gcsFeedUrl);

    const items = ensureArray(channel.item);
    if (items.length === 0) {
        throw new Error('No episodes found in feed');
    }

    const itemSlugs = items.map((item, index) => {
        const title = getText(item.title) || `Episode ${index + 1}`;
        const enclosureUrl = item?.enclosure?.['@_url'];
        const guidValue = getText(item.guid) || (typeof enclosureUrl === 'string' ? enclosureUrl : '');
        return computeEpisodeSlug(title, guidValue, index + 1);
    });

    for (const item of items) {
        brandEpisodeTitle(item);
    }

    const itemsWithIndex = items.map((item, index) => ({
        item,
        index,
        episodeSlug: itemSlugs[index],
    }));
    let itemsToProcess = itemsWithIndex;

    if (episodeQueries.length > 0) {
        itemsToProcess = itemsToProcess.filter(({ item }) => {
            const title = getText(item.title);
            return episodeQueries.some(query => matchesEpisodeQuery(title, query));
        });
        if (itemsToProcess.length === 0) {
            throw new Error('No episodes matched the provided --episode filters');
        }
    }

    const takeFirst = limit ?? first;
    if (takeFirst) {
        itemsToProcess = itemsToProcess.slice(0, takeFirst);
    } else if (last) {
        itemsToProcess = itemsToProcess.slice(-last);
    }

    const itemsToProcessCount = itemsToProcess.length;
    console.log(style.header('Episodes'));
    console.log(`  Total in feed: ${items.length}`);
    console.log(`  Processing: ${itemsToProcessCount}`);
    console.log();

    const baseOutputDir = outputDir || path.join(process.cwd(), 'output', mirrorSlug);
    await mkdir(baseOutputDir, { recursive: true });
    const existingMirror = await fetchExistingMirrorItems(`${gcsFeedUrl}?fresh=${Date.now()}`, gcsRoot);
    for (const item of existingMirror.itemsBySlug.values()) {
        brandEpisodeTitle(item);
    }
    await brandChannelArtwork(channel, baseOutputDir, gcsRoot, gcsFeedUrl, skipUpload);
    const existingSlugs = new Set(existingMirror.itemsBySlug.keys());
    const processedSlugs = new Set<string>();

    for (let index = 0; index < itemsToProcess.length; index++) {
        const { item, index: originalIndex, episodeSlug } = itemsToProcess[index];
        const title = getText(item.title) || `Episode ${originalIndex + 1}`;
        const enclosure = item.enclosure || {};
        const enclosureUrl = enclosure['@_url'] as string;
        const enclosureType = enclosure['@_type'] as string | undefined;
        const { ext, mime, codec } = guessAudioFormat(enclosureUrl, enclosureType);

        if (!enclosureUrl) {
            console.log(chalk.yellow(`  ⚠ Skipping episode without enclosure: ${title}`));
            continue;
        }

        const episodeDir = path.join(baseOutputDir, episodeSlug);
        const outputAudioPath = path.join(episodeDir, `${episodeSlug}.${ext}`);
        const chaptersJsonPath = path.join(episodeDir, `${episodeSlug}-chapters.json`);
        const episodeDescriptionPath = path.join(episodeDir, `${episodeSlug}-description.txt`);
        const gcsEpisodePath = `${gcsRoot}/${episodeSlug}`;
        const alreadyInFeed = existingSlugs.has(episodeSlug);
        let localOutputExists = false;
        let localDescriptionExists = false;
        try {
            const existingStat = await stat(episodeDir);
            if (existingStat.isDirectory()) {
                try {
                    const localOutputStat = await stat(outputAudioPath);
                    localOutputExists = localOutputStat.isFile();
                } catch {
                    localOutputExists = false;
                }
                try {
                    const localDescriptionStat = await stat(episodeDescriptionPath);
                    localDescriptionExists = localDescriptionStat.isFile();
                } catch {
                    localDescriptionExists = false;
                }
            }
        } catch {
            localOutputExists = false;
        }

        if (alreadyInFeed) {
            const mirroredItem = existingMirror.itemsBySlug.get(episodeSlug);
            if (mirroredItem) {
                applyMirroredItemFields(item, mirroredItem);
                await mkdir(episodeDir, { recursive: true });
                await brandEpisodeArtwork(item, episodeDir, gcsEpisodePath, episodeSlug, skipUpload);
                console.log(chalk.yellow(`  ↷ Skipping already imported: ${title}`));
            } else {
                console.log(chalk.yellow(`  ↷ Skipping already imported (missing mirrored metadata): ${title}`));
            }
            continue;
        }

        if (localOutputExists && localDescriptionExists) {
            console.log(chalk.yellow(`  ↷ Reusing existing local output: ${title}`));
            const outputStats = await applyLocalOutputFields({
                item,
                outputAudioPath,
                chaptersJsonPath,
                episodeDescriptionPath,
                gcsEpisodePath,
                episodeSlug,
                ext,
                mime,
            });
            await brandEpisodeArtwork(item, episodeDir, gcsEpisodePath, episodeSlug, skipUpload);
            if (!skipUpload) {
                console.log(chalk.gray('  Uploading cached processed audio...'));
                await uploadToGCS(outputAudioPath, `${GCS_BUCKET}/${gcsEpisodePath}/${episodeSlug}.${ext}`, mime);
                console.log(chalk.gray('  Uploading cached chapters JSON...'));
                await uploadToGCS(chaptersJsonPath, `${GCS_BUCKET}/${gcsEpisodePath}/${episodeSlug}-chapters.json`, 'application/json');
            }
            processedSlugs.add(episodeSlug);
            console.log(chalk.green(`  ✓ ${episodeSlug}.${ext} (${(outputStats.size / 1024 / 1024).toFixed(1)} MB)`));
            console.log();
            continue;
        }

        if (localOutputExists) {
            console.log(chalk.gray(`  Regenerating cached episode to add its ad-free description: ${title}`));
        }

        await mkdir(episodeDir, { recursive: true });

        console.log(chalk.blue.bold(`Episode ${originalIndex + 1}: ${title}`));

        const originalPath = path.join(episodeDir, `original.${ext}`);
        const transcriptWordsPath = path.join(episodeDir, 'transcript-words.json');

        try {
            const originalStats = await stat(originalPath);
            if (!originalStats.isFile()) throw new Error('not a file');
            console.log(chalk.gray('  Reusing original audio cache'));
        } catch {
            console.log(chalk.gray('  Downloading audio...'));
            await fetchLimit(() => downloadFile(enclosureUrl, originalPath));
        }

        const audioInfo = await getAudioInfo(originalPath);
        console.log(chalk.gray(`  Duration: ${audioInfo.durationSec.toFixed(1)}s`));

        let words: TranscriptWord[];
        try {
            const cachedWordsRaw = await readFile(transcriptWordsPath, 'utf-8');
            const cachedWords = JSON.parse(cachedWordsRaw) as TranscriptWord[];
            if (!Array.isArray(cachedWords) || cachedWords.length === 0) {
                throw new Error('invalid transcript cache shape');
            }
            const looksValid = cachedWords.every(word =>
                typeof word?.word === 'string'
                && typeof word?.startSec === 'number'
                && Number.isFinite(word.startSec)
                && typeof word?.endSec === 'number'
                && Number.isFinite(word.endSec)
                && word.endSec >= word.startSec
            );
            const maxEndSec = cachedWords.reduce((max, word) => Math.max(max, word.endSec), 0);
            if (!looksValid || maxEndSec < 30) {
                throw new Error('invalid transcript cache timestamps');
            }
            words = cachedWords;
            console.log(chalk.gray(`  Reusing transcript words cache: ${words.length}`));
        } catch {
            console.log(chalk.gray('  Transcribing audio...'));
            const transcriptionObjectPath = `${gcsRoot}/transcripts/${episodeSlug}.flac`;
            words = await transcribeAudioWithTimestamps(speechClient, originalPath, transcriptionObjectPath, languageCode);
            await writeFile(transcriptWordsPath, JSON.stringify(words), 'utf-8');
        }
        console.log(chalk.gray(`  Transcript words: ${words.length}`));

        const segments = buildTranscriptSegments(words);
        console.log(chalk.gray(`  Transcript segments: ${segments.length}`));

        console.log(chalk.gray('  Detecting ad reads...'));
        const labels = await classifyAdSegments(segments);
        const labelMap = new Map(labels.map(label => [label.index, label.label]));
        const interactionReminderSegmentIndexes = new Set(
            segments
                .filter(segment => {
                    const label = labelMap.get(segment.index);
                    if (label === 'interaction_reminder') return true;
                    return isInteractionReminderText(segment.text);
                })
                .map(segment => segment.index)
        );

        const adSegments = segments
            .filter(segment => labelMap.get(segment.index) === 'ad' && !interactionReminderSegmentIndexes.has(segment.index))
            .map(segment => ({
                startSec: Math.max(0, segment.startSec - AD_PADDING_SEC),
                endSec: Math.min(audioInfo.durationSec, segment.endSec + AD_PADDING_SEC),
            }));
        const sponsorKeywordRanges = detectSponsorKeywordRanges(words, audioInfo.durationSec);

        const interactionReminderSegments = segments
            .filter(segment => interactionReminderSegmentIndexes.has(segment.index))
            .map(segment => ({
                startSec: Math.max(0, segment.startSec - AD_PADDING_SEC),
                endSec: Math.min(audioInfo.durationSec, segment.endSec + AD_PADDING_SEC),
            }));

        const mergedAdRanges = mergeAdRanges([...adSegments, ...sponsorKeywordRanges]);
        const mergedInteractionReminderRanges = mergeAdRanges(interactionReminderSegments);
        const mergedRemovedRanges = mergeAdRanges([...mergedAdRanges, ...mergedInteractionReminderRanges]);
        const adDuration = mergedAdRanges.reduce((sum, range) => sum + (range.endSec - range.startSec), 0);
        const interactionReminderDuration = mergedInteractionReminderRanges.reduce((sum, range) => sum + (range.endSec - range.startSec), 0);
        const removedDuration = mergedRemovedRanges.reduce((sum, range) => sum + (range.endSec - range.startSec), 0);

        const sourceDescription = getSourceEpisodeDescription(item);
        const contentSegments = segments.filter(segment => !mergedRemovedRanges.some(range =>
            segment.startSec < range.endSec && segment.endSec > range.startSec
        ));
        console.log(chalk.gray('  Generating ad-free episode overview...'));
        const overviewSections = await generateEpisodeOverview({
            title,
            sourceDescription,
            segments: contentSegments,
        });
        const contentSegmentsByIndex = new Map(contentSegments.map(segment => [segment.index, segment]));
        const episodeDescription = formatEpisodeDescription(overviewSections.map(section => ({
            startMs: Math.round(adjustChapterStart(contentSegmentsByIndex.get(section.startSegmentIndex)!.startSec, mergedRemovedRanges) * 1000),
            summary: section.summary,
        })));
        await writeFile(episodeDescriptionPath, episodeDescription, 'utf-8');
        setEpisodeDescription(item, episodeDescription);
        console.log(chalk.green(`  Generated ${overviewSections.length} description sections`));

        if (mergedRemovedRanges.length === 0) {
            console.log(chalk.yellow('  No ad or interaction-reminder segments detected; mirroring original audio'));
            await copyFile(originalPath, outputAudioPath);
        } else {
            if (mergedAdRanges.length > 0) {
                console.log(chalk.green(`  Detected ${mergedAdRanges.length} ad ranges (${adDuration.toFixed(1)}s)`));
            }
            if (sponsorKeywordRanges.length > 0) {
                const hits = sponsorKeywordRanges.flatMap(range => range.hits);
                console.log(chalk.green(`  Sponsor keyword backstop: ${sponsorKeywordRanges.length} range(s), ${[...new Set(hits)].join(', ')}`));
            }
            if (mergedInteractionReminderRanges.length > 0) {
                console.log(chalk.green(`  Removing ${mergedInteractionReminderRanges.length} interaction-reminder ranges (${interactionReminderDuration.toFixed(1)}s)`));
            }

            const keepRanges = invertRanges(audioInfo.durationSec, mergedRemovedRanges);
            if (keepRanges.length === 0) {
                throw new Error('All transcript segments were marked for removal');
            }

            const segmentDir = path.join(episodeDir, 'segments');
            await mkdir(segmentDir, { recursive: true });

            const keepFiles: string[] = [];
            for (let i = 0; i < keepRanges.length; i++) {
                const segmentPath = path.join(segmentDir, `keep-${String(i + 1).padStart(3, '0')}.wav`);
                await extractSegment(originalPath, keepRanges[i], segmentPath, audioInfo.sampleRate, audioInfo.channels);
                keepFiles.push(segmentPath);
            }

            const adFiles: string[] = [];
            for (let i = 0; i < mergedAdRanges.length; i++) {
                const segmentPath = path.join(segmentDir, `ad-${String(i + 1).padStart(3, '0')}.wav`);
                await extractSegment(originalPath, mergedAdRanges[i], segmentPath, audioInfo.sampleRate, audioInfo.channels);
                adFiles.push(segmentPath);
            }

            const bitRateKbps = Math.max(64, Math.round((audioInfo.bitRate ?? 128000) / 1000));
            const concatOrder = [...keepFiles];
            if (mergedAdRanges.length > 0) {
                const announcementPath = path.join(segmentDir, 'announcement.wav');
                const announcementText = `starting ${mergedAdRanges.length} spliced ad ${mergedAdRanges.length === 1 ? 'read' : 'reads'}`;
                await synthesizeAnnouncement(announcementText, announcementPath, audioInfo.sampleRate, audioInfo.channels, voice, dialect);
                concatOrder.push(announcementPath, ...adFiles);
            }

            await concatSegments(concatOrder, outputAudioPath, codec, audioInfo.sampleRate, audioInfo.channels, bitRateKbps);
        }

        const outputInfo = await getAudioInfo(outputAudioPath);
        const outputStats = await stat(outputAudioPath);

        const originalChapters = ensureArray(item['psc:chapters']?.['psc:chapter']).map((chapter: any) => ({
            title: chapter['@_title'] || 'Chapter',
            startSec: parseChapterStart(chapter['@_start'] || '0:00:00'),
        }));

        const mainDurationSec = mergedRemovedRanges.length > 0
            ? Math.max(0, audioInfo.durationSec - removedDuration)
            : outputInfo.durationSec;

        const chapters = buildChapters(
            originalChapters,
            mergedRemovedRanges,
            mainDurationSec,
            mergedAdRanges.length > 0,
            mergedAdRanges.length,
        );

        const chaptersJson = generateJsonChapters(
            chapters.map(ch => ({ title: ch.title, startMs: ch.startMs })),
            getText(item.link)
        );

        await writeFile(chaptersJsonPath, JSON.stringify(chaptersJson, null, 2), 'utf-8');

        const audioUrl = `${GCS_BASE_URL}/${gcsEpisodePath}/${episodeSlug}.${ext}`;
        const chaptersJsonUrl = `${GCS_BASE_URL}/${gcsEpisodePath}/${episodeSlug}-chapters.json`;

        item.enclosure = {
            ...item.enclosure,
            '@_url': audioUrl,
            '@_length': String(outputStats.size),
            '@_type': mime,
        };

        item.guid = updateGuid(item.guid, audioUrl);
        item['itunes:duration'] = setText(item['itunes:duration'], formatMs(Math.round(outputInfo.durationSec * 1000)));

        item['psc:chapters'] = {
            '@_version': '1.2',
            'psc:chapter': chapters.map(chapter => ({
                '@_start': formatChapterTime(chapter.startMs),
                '@_title': chapter.title,
            })),
        };

        item['podcast:chapters'] = {
            '@_url': chaptersJsonUrl,
            '@_type': 'application/json+chapters',
        };
        await brandEpisodeArtwork(item, episodeDir, gcsEpisodePath, episodeSlug, skipUpload);

        if (!skipUpload) {
            console.log(chalk.gray('  Uploading processed audio...'));
            await uploadToGCS(outputAudioPath, `${GCS_BUCKET}/${gcsEpisodePath}/${episodeSlug}.${ext}`, mime);
            console.log(chalk.gray('  Uploading chapters JSON...'));
            await uploadToGCS(chaptersJsonPath, `${GCS_BUCKET}/${gcsEpisodePath}/${episodeSlug}-chapters.json`, 'application/json');
        }

        processedSlugs.add(episodeSlug);
        console.log(chalk.green(`  ✓ ${episodeSlug}.${ext} (${(outputStats.size / 1024 / 1024).toFixed(1)} MB)`));
        console.log();
    }

    channel.item = buildMergedMirrorItems({
        sourceItems: items,
        existingItemsBySlug: existingMirror.itemsBySlug,
        existingSlugsInOrder: existingMirror.slugsInOrder,
        processedSlugs,
        getSlugForSourceItem: (_item, index) => itemSlugs[index],
    });

    const builder = new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        suppressEmptyNode: true,
    });
    const updatedXml = builder.build(parsed);

    const feedOutputPath = path.join(baseOutputDir, 'feed.xml');
    await writeFile(feedOutputPath, updatedXml, 'utf-8');

    if (!skipUpload) {
        await uploadToGCS(feedOutputPath, `${GCS_BUCKET}/${gcsRoot}/feed.xml`, 'application/rss+xml');
    }

    console.log(style.header('Mirror Complete'));
    console.log(`  Feed title: ${mirrorTitle}`);
    console.log(`  Feed URL: ${gcsFeedUrl}`);
    console.log(`  Output: ${baseOutputDir}`);
});
