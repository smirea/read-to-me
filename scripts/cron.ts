#!/usr/bin/env bun
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

import { GCS_BASE_URL } from '../src/constants';
import { computeEpisodeSlug, extractEpisodeSlug, slugify } from '../src/podcast-mirror/feed-utils';
import { fetchWithUA } from '../src/utils/fetch';

const podcasts = [
    {
        name: 'TRIGGERnometry',
        feedUrl: 'https://feeds.megaphone.fm/AALT9618167458',
    },
    {
        name: 'Huberman Lab',
        feedUrl: 'https://feeds.megaphone.fm/hubermanlab',
    },
    {
        name: 'The Diary Of A CEO',
        feedUrl: 'https://feeds.megaphone.fm/thediaryofaceo',
    },
];

const RECENT_DAYS = 7;
const projectRoot = path.resolve(import.meta.dir, '..');
const bunExecutable = process.execPath;

ensurePath([
    path.dirname(bunExecutable),
    process.env.HOME ? path.join(process.env.HOME, '.bun', 'bin') : '',
    process.env.HOME ? path.join(process.env.HOME, '.local', 'bin') : '',
    process.env.HOME ? path.join(process.env.HOME, 'bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
]);

interface FeedItem {
    title: string;
    slug: string;
    pubDate: Date | null;
}

interface PodcastState {
    podcast: typeof podcasts[number];
    items: FeedItem[];
    parsedSlugs: Set<string>;
}

const argv = new Set(Bun.argv.slice(2));

try {
    if (argv.has('--print')) {
        await printPodcastTable();
    } else {
        await runCron();
    }
} catch (error) {
    await notifyHermes(error);
    throw error;
}

async function runCron(): Promise<void> {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);

    for (const podcast of podcasts) {
        const state = await getPodcastState(podcast);
        const episodesToParse = state.items
            .filter(({ pubDate }) => pubDate && pubDate >= cutoff)
            .filter(({ slug }) => !state.parsedSlugs.has(slug));

        if (episodesToParse.length === 0) {
            console.log(`${podcast.name}: no unparsed episodes from the last ${RECENT_DAYS} days`);
            continue;
        }

        console.log(`${podcast.name}: parsing ${episodesToParse.length} episode(s)`);
        for (const episode of episodesToParse) {
            console.log(`  ${episode.title}`);
        }

        const episodeArgs = episodesToParse.flatMap(episode => ['--episode', episode.title]);
        await runCommand([
            bunExecutable,
            'src/podcast-mirror.ts',
            podcast.feedUrl,
            ...episodeArgs,
        ], {
            cwd: projectRoot,
            stdio: 'inherit',
        });
    }
}

async function printPodcastTable(): Promise<void> {
    const rows: Array<Record<string, string>> = [];
    for (const podcast of podcasts) {
        const state = await getPodcastState(podcast);
        rows.push({
            podcast: podcast.name,
            feedUrl: podcast.feedUrl,
            parsed: String(state.parsedSlugs.size),
        });
    }

    printTable(rows, ['podcast', 'feedUrl', 'parsed']);
}

async function getPodcastState(podcast: typeof podcasts[number]): Promise<PodcastState> {
    const feedXml = await fetchText(podcast.feedUrl);
    const parsed = parseFeed(feedXml);
    const channel = parsed?.rss?.channel;
    if (!channel) {
        throw new Error(`Invalid RSS feed for ${podcast.name}: missing channel`);
    }

    const sourceTitle = getText(channel.title) || podcast.name;
    const mirrorSlug = slugify(`R2M: ${sourceTitle}`, 80) || 'r2m-podcast';
    const mirrorFeedUrl = `${GCS_BASE_URL}/${mirrorSlug}/feed.xml`;
    const items = ensureArray(channel.item).map((item, index) => {
        const title = getText(item.title) || `Episode ${index + 1}`;
        const enclosureUrl = item?.enclosure?.['@_url'];
        const guidValue = getText(item.guid) || (typeof enclosureUrl === 'string' ? enclosureUrl : '');
        return {
            title,
            slug: computeEpisodeSlug(title, guidValue, index + 1),
            pubDate: parsePubDate(getText(item.pubDate)),
        };
    });

    const parsedSlugs = await fetchParsedSlugs(mirrorFeedUrl, mirrorSlug);

    return {
        podcast,
        items,
        parsedSlugs,
    };
}

async function fetchParsedSlugs(feedUrl: string, mirrorSlug: string): Promise<Set<string>> {
    try {
        const feedXml = await fetchText(`${feedUrl}?fresh=${Date.now()}`);
        const parsed = parseFeed(feedXml);
        const slugs = new Set<string>();

        for (const item of ensureArray(parsed?.rss?.channel?.item)) {
            const enclosureUrl = item?.enclosure?.['@_url'];
            if (typeof enclosureUrl !== 'string') continue;
            const slug = extractEpisodeSlug(enclosureUrl, mirrorSlug);
            if (slug) slugs.add(slug);
        }

        return slugs;
    } catch {
        return new Set();
    }
}

async function fetchText(url: string): Promise<string> {
    const response = await fetchWithUA(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response.text();
}

function parseFeed(xml: string): any {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: false,
        isArray: name => name === 'item',
    }).parse(xml);
}

function getText(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && '#text' in value) return String(value['#text'] ?? '');
    return '';
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function ensurePath(paths: string[]): void {
    const entries = [
        ...paths,
        ...(process.env.PATH ?? '').split(':'),
    ].filter(Boolean);
    process.env.PATH = [...new Set(entries)].join(':');
}

function parsePubDate(value: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
    const widths = columns.map(column => Math.max(
        column.length,
        ...rows.map(row => row[column].length),
    ));
    const line = (values: string[]) => values
        .map((value, index) => value.padEnd(widths[index]))
        .join('  ');

    console.log(line(columns));
    console.log(line(widths.map(width => '-'.repeat(width))));
    for (const row of rows) {
        console.log(line(columns.map(column => row[column])));
    }
}

async function notifyHermes(error: unknown): Promise<void> {
    const message = [
        'Let Stefan know on Telegram that read-to-me podcast cron failed.',
        '',
        formatError(error),
    ].join('\n');

    const candidates = [
        ['hermes', message],
        ['ssh', '-o', 'RemoteCommand=none', '-T', 'mini', 'hermes', message],
    ];

    for (const candidate of candidates) {
        try {
            await runCommand(candidate, {
                cwd: projectRoot,
                stdio: 'ignore',
                timeoutMs: 30_000,
            });
            return;
        } catch {
            continue;
        }
    }

    console.error('Could not notify Hermes about cron failure');
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

async function runCommand(
    command: string[],
    options: {
        cwd: string;
        stdio: 'inherit' | 'ignore';
        timeoutMs?: number;
    },
): Promise<void> {
    const controller = new AbortController();
    const timeout = options.timeoutMs
        ? setTimeout(() => controller.abort(), options.timeoutMs)
        : null;

    try {
        const process = Bun.spawn(command, {
            cwd: options.cwd,
            stdout: options.stdio,
            stderr: options.stdio,
            stdin: 'ignore',
            signal: controller.signal,
        });
        const exitCode = await process.exited;
        if (exitCode !== 0) {
            throw new Error(`${command[0]} exited with code ${exitCode}`);
        }
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
