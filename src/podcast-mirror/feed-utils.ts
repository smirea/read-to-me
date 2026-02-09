import { createHash } from 'crypto';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slugify(value: string, maxLen = 60): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLen)
        .replace(/-+$/g, '');
}

export function hashString(value: string): string {
    return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

export function computeEpisodeSlug(title: string, guidValue: string, fallbackIndex: number): string {
    const slugBase = slugify(title) || `episode-${fallbackIndex}`;
    return `${slugBase}_${hashString(guidValue)}`;
}

export function extractEpisodeSlug(enclosureUrl: string, gcsRoot: string): string | null {
    if (!enclosureUrl) return null;
    const escapedRoot = escapeRegExp(gcsRoot);
    const match = enclosureUrl.match(new RegExp(`/${escapedRoot}/([^/]+)/`));
    return match ? match[1] : null;
}

export function applyMirroredItemFields(targetItem: any, mirroredItem: any): void {
    if (mirroredItem?.enclosure) targetItem.enclosure = mirroredItem.enclosure;
    if (mirroredItem?.guid) targetItem.guid = mirroredItem.guid;
    if (mirroredItem?.['itunes:duration']) targetItem['itunes:duration'] = mirroredItem['itunes:duration'];
    if (mirroredItem?.['psc:chapters']) targetItem['psc:chapters'] = mirroredItem['psc:chapters'];
    if (mirroredItem?.['podcast:chapters']) targetItem['podcast:chapters'] = mirroredItem['podcast:chapters'];
}

export function buildMergedMirrorItems(options: {
    sourceItems: any[];
    existingItemsBySlug: Map<string, any>;
    existingSlugsInOrder: string[];
    processedSlugs: Set<string>;
    getSlugForSourceItem: (item: any, index: number) => string;
}): any[] {
    const includedSlugs = new Set<string>([
        ...options.existingItemsBySlug.keys(),
        ...options.processedSlugs,
    ]);

    const outputItems: any[] = [];
    const seenSlugs = new Set<string>();

    for (let i = 0; i < options.sourceItems.length; i++) {
        const item = options.sourceItems[i];
        const slug = options.getSlugForSourceItem(item, i);
        if (!includedSlugs.has(slug)) continue;

        if (!options.processedSlugs.has(slug)) {
            const mirroredItem = options.existingItemsBySlug.get(slug);
            if (mirroredItem) applyMirroredItemFields(item, mirroredItem);
        }

        outputItems.push(item);
        seenSlugs.add(slug);
    }

    for (const slug of options.existingSlugsInOrder) {
        if (seenSlugs.has(slug)) continue;
        const mirroredItem = options.existingItemsBySlug.get(slug);
        if (mirroredItem) outputItems.push(mirroredItem);
    }

    return outputItems;
}

