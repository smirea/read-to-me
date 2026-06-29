import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import sharp from 'sharp';
import { fetchWithUA } from '../utils/fetch';

export const MIRROR_BRAND_LABEL = 'unADdicted';
export const MIRROR_BRAND_PREFIX = `${MIRROR_BRAND_LABEL}: `;

const ARTWORK_SIZE = 1400;
const BORDER_WIDTH = 48;
const FRAME_RADIUS = 28;
const BORDER_COLOR = '#0f172b';
const TAG_COLOR = '#fff';
const LABEL_FONT_SIZE = 120;
const LABEL_PADDING = BORDER_WIDTH / 2;
const LABEL_RADIUS = BORDER_WIDTH;
const LABEL_WIDTH = 800;
const LABEL_HEIGHT = 164;
const TRANSPARENT_CONTENT_PAD = BORDER_WIDTH * 2;
const TRANSPARENT_LABEL_GAP = BORDER_WIDTH / 2;

export function prefixMirrorText(value: string): string {
    if (value.startsWith(MIRROR_BRAND_PREFIX)) return value;
    return `${MIRROR_BRAND_PREFIX}${value}`;
}

export async function renderMirrorArtwork(sourceUrl: string, outputPath: string): Promise<void> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    const response = await fetchWithUA(sourceUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch artwork ${sourceUrl}: ${response.status}`);
    }

    const input = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(input).metadata();
    const hasAlpha = Boolean(metadata.hasAlpha);
    const hasWhiteBackground = !hasAlpha && await likelyEdgeWhiteBackground(input);

    const output = hasAlpha || hasWhiteBackground
        ? await renderTransparentArtwork(input, hasWhiteBackground)
        : await renderSquareArtwork(input);

    await writeFile(outputPath, output);
}

function labelSvg(): Buffer {
    return Buffer.from(`
        <svg width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
            <path
                d="M 0 ${LABEL_HEIGHT} L 0 ${LABEL_RADIUS} Q 0 0 ${LABEL_RADIUS} 0 L ${LABEL_WIDTH} 0 L ${LABEL_WIDTH} ${LABEL_HEIGHT} Z"
                fill="${BORDER_COLOR}"
            />
            <text
                x="${LABEL_PADDING}"
                y="${LABEL_PADDING}"
                font-family="Menlo, Monaco, Consolas, monospace"
                font-size="${LABEL_FONT_SIZE}"
                font-weight="500"
                fill="${TAG_COLOR}"
                dominant-baseline="hanging"
            ><tspan>un</tspan><tspan font-weight="800">AD</tspan><tspan>dicted</tspan></text>
        </svg>
    `);
}

async function renderSquareArtwork(input: Buffer): Promise<Buffer> {
    const frame = Buffer.from(`
        <svg width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" rx="${FRAME_RADIUS}" ry="${FRAME_RADIUS}" fill="${BORDER_COLOR}" />
        </svg>
    `);
    const imageSize = ARTWORK_SIZE - BORDER_WIDTH * 2;
    const image = await sharp(input)
        .resize(imageSize, imageSize, { fit: 'cover' })
        .png()
        .toBuffer();

    return sharp(frame)
        .composite([
            { input: image, top: BORDER_WIDTH, left: BORDER_WIDTH },
            { input: labelSvg(), top: ARTWORK_SIZE - LABEL_HEIGHT, left: ARTWORK_SIZE - LABEL_WIDTH },
        ])
        .png()
        .toBuffer();
}

async function renderTransparentArtwork(input: Buffer, removeWhiteBackground: boolean): Promise<Buffer> {
    const labelMargin = BORDER_WIDTH;
    const labelTop = ARTWORK_SIZE - labelMargin - LABEL_HEIGHT;
    const maxContentWidth = ARTWORK_SIZE - TRANSPARENT_CONTENT_PAD * 2;
    const maxContentHeight = labelTop - TRANSPARENT_LABEL_GAP - TRANSPARENT_CONTENT_PAD;
    const resizedContent = await sharp(input)
        .resize(maxContentWidth, maxContentHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .ensureAlpha()
        .png()
        .toBuffer();
    let content = await sharp({
        create: {
            width: ARTWORK_SIZE,
            height: ARTWORK_SIZE,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: resizedContent, top: TRANSPARENT_CONTENT_PAD, left: TRANSPARENT_CONTENT_PAD }])
        .png()
        .toBuffer();

    if (removeWhiteBackground) {
        content = await removeExteriorWhite(content);
    }

    const borderLayer = await buildTransparentOutlineLayer(content);

    return sharp({
        create: {
            width: ARTWORK_SIZE,
            height: ARTWORK_SIZE,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([
            { input: borderLayer, top: 0, left: 0 },
            { input: content, top: 0, left: 0 },
            { input: labelSvg(), top: ARTWORK_SIZE - labelMargin - LABEL_HEIGHT, left: ARTWORK_SIZE - labelMargin - LABEL_WIDTH },
        ])
        .png()
        .toBuffer();
}

async function likelyEdgeWhiteBackground(input: Buffer): Promise<boolean> {
    const { data, info } = await sharp(input)
        .resize(80, 80, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let whiteEdgeCount = 0;
    let edgeCount = 0;

    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            if (x !== 0 && y !== 0 && x !== info.width - 1 && y !== info.height - 1) continue;
            edgeCount++;
            const offset = (y * info.width + x) * info.channels;
            if (isNearWhite(data[offset], data[offset + 1], data[offset + 2])) whiteEdgeCount++;
        }
    }

    return whiteEdgeCount / edgeCount > 0.85;
}

async function removeExteriorWhite(input: Buffer): Promise<Buffer> {
    const { data, info } = await sharp(input)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const exterior = findExteriorPixels(data, info.width, info.height, (offset) => {
        const alpha = data[offset + 3];
        return alpha <= 12 || isNearWhite(data[offset], data[offset + 1], data[offset + 2]);
    });

    for (let index = 0; index < exterior.length; index++) {
        if (!exterior[index]) continue;
        data[index * 4 + 3] = 0;
    }

    return sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
    }).png().toBuffer();
}

async function buildTransparentOutlineLayer(content: Buffer): Promise<Buffer> {
    const radius = BORDER_WIDTH;
    const dataUri = `data:image/png;base64,${content.toString('base64')}`;
    const svg = Buffer.from(`
        <svg width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="outline" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
                    <feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="dilated"/>
                    <feFlood flood-color="${BORDER_COLOR}" result="color"/>
                    <feComposite in="color" in2="dilated" operator="in"/>
                </filter>
            </defs>
            <image href="${dataUri}" width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" filter="url(#outline)"/>
        </svg>
    `);

    return sharp(svg).png().toBuffer();
}

function findExteriorPixels(
    data: Buffer,
    width: number,
    height: number,
    isOpen: (offset: number) => boolean,
): Uint8Array {
    const exterior = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const push = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const index = y * width + x;
        if (exterior[index]) return;
        if (!isOpen(index * 4)) return;
        exterior[index] = 1;
        queue[tail++] = index;
    };

    for (let x = 0; x < width; x++) {
        push(x, 0);
        push(x, height - 1);
    }
    for (let y = 1; y < height - 1; y++) {
        push(0, y);
        push(width - 1, y);
    }

    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
    }

    return exterior;
}

function isNearWhite(r: number, g: number, b: number): boolean {
    return r >= 245 && g >= 245 && b >= 245 && Math.max(r, g, b) - Math.min(r, g, b) <= 12;
}
