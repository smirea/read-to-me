import { marked } from 'marked';

import { escapeXml } from './shared';

type ChapterHtmlOptions = {
    episodeTitle: string;
    chapterTitle: string;
    content: string;
    images: Array<{
        originalUrl: string;
        gcsUrl: string;
        description: string;
    }>;
    chapterIndex: number;
    totalChapters: number;
    sourceUrl: string;
    allChapters: Array<{
        title: string;
        pageUrl: string;
    }>;
    pageUrl: string;
    episodeThumbnailUrl: string;
    chapterImageUrl?: string;
};

export function generateChapterHtml(options: ChapterHtmlOptions): string {
    const chapterLinks = options.allChapters.map((chapter, index) => {
        const current = index === options.chapterIndex ? ' aria-current="page"' : '';
        return `<li><a href="${escapeXml(chapter.pageUrl)}"${current}>${escapeXml(chapter.title)}</a></li>`;
    }).join('\n');
    const imageBlocks = options.images.map(image => `
        <figure>
            <img src="${escapeXml(image.gcsUrl)}" alt="${escapeXml(image.description)}">
            <figcaption>${escapeXml(image.description)}</figcaption>
        </figure>`).join('\n');
    const body = marked.parse(options.content, { async: false }) as string;
    const heroImage = options.chapterImageUrl || options.episodeThumbnailUrl;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeXml(options.chapterTitle)} - ${escapeXml(options.episodeTitle)}</title>
    <meta property="og:title" content="${escapeXml(options.chapterTitle)}">
    <meta property="og:url" content="${escapeXml(options.pageUrl)}">
    <meta property="og:image" content="${escapeXml(heroImage)}">
    <style>
        :root {
            color-scheme: light dark;
            font-family: ui-serif, Georgia, serif;
            line-height: 1.55;
        }
        body {
            margin: 0;
            background: #f7f4ef;
            color: #191714;
        }
        main {
            max-width: 760px;
            margin: 0 auto;
            padding: 32px 20px 56px;
        }
        header img {
            width: 100%;
            max-height: 420px;
            object-fit: cover;
            border-radius: 8px;
        }
        h1 {
            font-size: clamp(2rem, 6vw, 3.75rem);
            line-height: 1.05;
            margin: 24px 0 8px;
        }
        .meta {
            color: #665f55;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 0.95rem;
        }
        article {
            font-size: 1.1rem;
        }
        article img {
            max-width: 100%;
            height: auto;
        }
        figure {
            margin: 32px 0;
        }
        figure img {
            width: 100%;
            border-radius: 8px;
        }
        figcaption {
            color: #665f55;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 0.9rem;
            margin-top: 8px;
        }
        nav {
            border-top: 1px solid #d8d1c7;
            margin-top: 40px;
            padding-top: 24px;
            font-family: ui-sans-serif, system-ui, sans-serif;
        }
        nav ul {
            padding-left: 20px;
        }
        a {
            color: #075985;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background: #161412;
                color: #f7f4ef;
            }
            .meta,
            figcaption {
                color: #c4baad;
            }
            nav {
                border-top-color: #3b332b;
            }
            a {
                color: #7dd3fc;
            }
        }
    </style>
</head>
<body>
    <main>
        <header>
            <img src="${escapeXml(heroImage)}" alt="">
            <h1>${escapeXml(options.chapterTitle)}</h1>
            <p class="meta">${escapeXml(options.episodeTitle)} · Chapter ${options.chapterIndex + 1} of ${options.totalChapters}</p>
            <p class="meta"><a href="${escapeXml(options.sourceUrl)}">Original article</a></p>
        </header>
        <article>
            ${body}
            ${imageBlocks}
        </article>
        <nav aria-label="Episode chapters">
            <strong>Chapters</strong>
            <ul>
${chapterLinks}
            </ul>
        </nav>
    </main>
</body>
</html>`;
}
