#!/usr/bin/env bun
import chalk from 'chalk';
import { rm, unlink } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';

import { createScript, style } from './utils/createScript';
import { fetchWithUA } from './utils/fetch';
import { formatMs } from './utils/time';

import { argv } from './cli';
import { FETCH_CONCURRENCY, GCS_BASE_URL, GCS_BUCKET } from './constants';
import type { ChapterImageData, ChapterMetadata, EpisodeData } from './types';
import { buildNarratorAttribution, resolveVoice, VOICE_GENDERS, type EnglishDialect } from './voice';

// Content
import { extractContent, fetchWebpage, filterContentWithAI } from './content';

// AI Processing
import {
    enhanceContentForTTS,
    generateSummary,
    processImagesInContent,
    processTablesInContent,
    suggestChapters,
} from './ai';

// Audio
import { synthesizeContent } from './audio';

// Thumbnail
import { generateThumbnail } from './thumbnail';

// Output
import { generateFfmetadata, generateMarkdown, generateRssFeed, generateJsonChapters, updateMasterFeed, getNextEpisodeNumber, findExistingEpisode, buildDescriptionWithImages } from './output';
import { generateChapterHtml } from './output/chapter-html';

// Upload
import { uploadToGCS, deleteGCSFolder } from './upload';

const fetchLimit = pLimit(FETCH_CONCURRENCY);

void createScript(async () => {
    const url = argv.url as string;
    const voice = resolveVoice(argv.voice);
    const dialect = argv.dialect as EnglishDialect;
    const output = argv.output;
    const noUpload = argv['skip-upload'];
    const enhanceSpeech = argv['enhance-speech'];

    console.log(style.header('Read To Me'));
    console.log('Configuration:');
    console.log(`  URL: ${url}`);
    console.log(`  Voice: ${dialect}-Chirp3-HD-${voice} (${VOICE_GENDERS[voice]})`);
    console.log(`  Dialect: ${dialect}`);
    console.log(`  Output: ${output || '(auto)'}`);
    console.log(`  Upload: ${noUpload ? 'disabled' : 'enabled'}`);
    console.log(`  Speech enhancement: ${enhanceSpeech ? 'enabled' : 'disabled'}`);
    console.log();

    // Step 1: Extract content from webpage
    const html = await fetchWebpage(url);
    let content = extractContent(html, url);

    console.log();
    console.log(style.header('Content Summary'));
    console.log(`  Title: ${content.title}`);
    if (content.byline) console.log(`  Author: ${content.byline}`);
    console.log(`  Chapters: ${content.chapters.length}`);
    for (const chapter of content.chapters) {
        console.log(`    - ${chapter.title} (${chapter.content.length} chars, ${chapter.images.length} images)`);
    }

    // Step 2: Filter content to remove ads, comments, and non-article content
    console.log();
    content = await filterContentWithAI(content);

    // Step 3: Use AI to suggest better chapter divisions
    console.log();
    content = await suggestChapters(content);

    // Step 3.5: Generate a summary for RSS feed and metadata
    console.log();
    const baseSummary = await generateSummary(content);

    // Build narrator attribution
    const narrator = buildNarratorAttribution(voice, dialect);
    const summary = `${baseSummary}\n\nSource: ${url}\n\nNarrated by ${narrator}`;

    // Update summary after processing
    console.log();
    console.log(style.header('Final Chapter Structure'));
    console.log(`  Chapters: ${content.chapters.length}`);
    for (const chapter of content.chapters) {
        console.log(`    - ${chapter.title} (${chapter.content.length} chars)`);
    }

    // Store content BEFORE image processing for chapter HTML pages (with original markdown images)
    const contentForHtmlPages = structuredClone(content);

    // Step 4: Process images with Gemini
    // Store image descriptions for later use in episode description and HTML pages
    let imageDescriptions = new Map<string, string>();
    if (content.allImages.length > 0) {
        console.log();
        const imageResult = await processImagesInContent(content);
        content = imageResult.content;
        imageDescriptions = imageResult.imageDescriptions;
    }

    // Step 5: Process tables with Gemini
    if (content.allTables.length > 0) {
        console.log();
        content = await processTablesInContent(content);
    }

    // Step 5.5: Enhance content for TTS (convert to SSML)
    console.log();
    content = await enhanceContentForTTS(content);

    // Step 6: Synthesize audio with Google Chirp 3
    console.log();
    const chapterAudios = await synthesizeContent(content, voice, dialect);

    // Step 7: Get episode number and save files
    const masterFeedUrl = `${GCS_BASE_URL}/read-to-me/feed.xml`;
    const rawSlug = content.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

    // Check if this URL has been processed before
    const existingEpisode = await findExistingEpisode(masterFeedUrl, url);
    let episodeNumber: string;
    let titleSlug: string;

    if (existingEpisode) {
        // Re-processing: use existing episode number and slug
        episodeNumber = String(existingEpisode.episodeNumber).padStart(3, '0');
        titleSlug = existingEpisode.slug;
        console.log(`  Episode: #${existingEpisode.episodeNumber} (re-processing)`);

        // Delete old local output directory if it exists
        const oldOutputDir = path.join(process.cwd(), 'output', titleSlug);
        try {
            await rm(oldOutputDir, { recursive: true, force: true });
            console.log(chalk.yellow(`  Deleted old output: ${oldOutputDir}`));
        } catch {
            // Directory might not exist locally
        }
    } else {
        // New episode
        const nextEpisodeNumber = await getNextEpisodeNumber(masterFeedUrl);
        episodeNumber = String(nextEpisodeNumber).padStart(3, '0');
        titleSlug = `${episodeNumber}_${rawSlug}`;
        console.log(`  Episode: #${nextEpisodeNumber} (new)`);
    }

    const outputDir = output
        ? path.resolve(output)
        : path.join(process.cwd(), 'output', titleSlug);
    // Use the folder name for the final audio file
    const outputBase = path.basename(outputDir);
    await Bun.write(path.join(outputDir, '.gitkeep'), ''); // Ensure dir exists

    console.log();
    console.log(style.header('Saving Audio Files'));
    console.log(`  Output directory: ${outputDir}`);

    // Create combined audio file with embedded chapter metadata (M4A format)
    const combinedBuffer = Buffer.concat(chapterAudios.map(a => a.audioBuffer));
    const tempPcmPath = path.join(outputDir, `${outputBase}.temp.pcm`);
    await Bun.write(tempPcmPath, combinedBuffer);

    // Calculate chapter timestamps
    let currentTime = 0;
    const chapters: ChapterMetadata[] = chapterAudios.map((audio, i) => {
        const chapter = {
            index: i + 1,
            title: audio.title,
            startMs: currentTime,
            endMs: currentTime + audio.durationMs,
            startFormatted: formatMs(currentTime),
        };
        currentTime += audio.durationMs;
        return chapter;
    });

    // Generate ffmetadata file for chapters
    const ffmetadataContent = generateFfmetadata(content, chapters, currentTime, summary, narrator, url);
    const ffmetadataPath = path.join(outputDir, 'ffmetadata.txt');
    await Bun.write(ffmetadataPath, ffmetadataContent);

    // Convert to M4A with embedded chapters using ffmpeg
    const combinedPath = path.join(outputDir, `${outputBase}.m4a`);
    console.log(chalk.gray('  Converting to M4A with embedded chapters...'));

    // PCM input flags: -f s16le (signed 16-bit little-endian), -ar 24000 (sample rate), -ac 1 (mono)
    // -map 0:a takes audio from first input, -map_chapters 1 takes chapters from ffmetadata file
    const ffmpegResult = await Bun.$`ffmpeg -y -f s16le -ar 24000 -ac 1 -i ${tempPcmPath} -f ffmetadata -i ${ffmetadataPath} -map 0:a -map_chapters 1 -map_metadata 1 -c:a aac -b:a 192k -movflags +faststart ${combinedPath}`.quiet();
    if (ffmpegResult.exitCode !== 0) {
        console.log(chalk.red('  ✗ ffmpeg conversion failed'));
        console.log(chalk.gray(ffmpegResult.stderr.toString()));
        await unlink(tempPcmPath).catch(() => {});
        throw new Error('Failed to convert audio to M4A');
    }
    // Clean up temp files
    await unlink(tempPcmPath);
    await unlink(ffmetadataPath);
    console.log(chalk.green.bold(`  ✓ ${outputBase}.m4a (combined with chapters)`));

    // Generate chapter metadata JSON file
    const metadataPath = path.join(outputDir, 'chapters.json');
    await Bun.write(metadataPath, JSON.stringify({
        title: content.title,
        author: content.byline,
        narrator,
        summary,
        voice,
        dialect,
        sourceUrl: url,
        totalDurationMs: currentTime,
        totalDurationFormatted: formatMs(currentTime),
        chapters: chapters.map(c => ({
            index: c.index,
            title: c.title,
            startMs: c.startMs,
            startFormatted: c.startFormatted,
        })),
    }, null, 2));
    console.log(chalk.green(`  ✓ chapters.json`));

    // Save markdown content
    const markdownContent = generateMarkdown(content, url);
    const markdownPath = path.join(outputDir, 'article.md');
    await Bun.write(markdownPath, markdownContent);
    console.log(chalk.green(`  ✓ article.md`));

    // Save all images from the article (in parallel)
    if (content.allImages.length > 0) {
        console.log(chalk.gray(`  Saving ${content.allImages.length} images (concurrency: ${FETCH_CONCURRENCY})...`));
        const imagesDir = path.join(outputDir, 'images');
        await Bun.write(path.join(imagesDir, '.gitkeep'), ''); // Ensure dir exists

        const imageDownloadPromises = content.allImages.map((imgUrl, i) =>
            fetchLimit(async () => {
                try {
                    const response = await fetchWithUA(imgUrl);
                    if (!response.ok) return { success: false, error: 'Response not ok' };

                    const contentType = response.headers.get('content-type') || 'image/jpeg';
                    const ext = contentType.includes('png') ? 'png'
                        : contentType.includes('gif') ? 'gif'
                        : contentType.includes('webp') ? 'webp'
                        : contentType.includes('svg') ? 'svg'
                        : 'jpg';
                    const filename = `${String(i + 1).padStart(2, '0')}-image.${ext}`;
                    const imagePath = path.join(imagesDir, filename);
                    const arrayBuffer = await response.arrayBuffer();
                    await Bun.write(imagePath, Buffer.from(arrayBuffer));
                    console.log(chalk.green(`  ✓ images/${filename}`));
                    return { success: true, filename };
                } catch {
                    console.log(chalk.yellow(`  ⚠ Could not save image: ${imgUrl.slice(0, 50)}...`));
                    return { success: false, error: 'Fetch failed' };
                }
            })
        );

        await Promise.all(imageDownloadPromises);
    }

    // Step 8: Generate thumbnail
    console.log();
    console.log(style.header('Generating Thumbnail'));
    const thumbnailPath = path.join(outputDir, 'thumbnail.png');
    await generateThumbnail(content, thumbnailPath, url);
    console.log(chalk.green(`  ✓ thumbnail.png`));

    // Step 9: Upload to GCS and generate RSS feed (unless --skip-upload)
    let podcastUrl: string | null = null;
    if (!noUpload) {
        console.log();
        console.log(style.header('Uploading to GCS'));

        const gcsPath = `read-to-me/${titleSlug}`;

        // Delete old GCS assets if re-processing
        if (existingEpisode) {
            console.log(chalk.gray(`  Deleting old GCS assets...`));
            const deletedCount = await deleteGCSFolder(GCS_BUCKET, `${gcsPath}/`);
            console.log(chalk.yellow(`  Deleted ${deletedCount} old files from GCS`));
        }

        // Upload M4A audio file
        console.log(chalk.gray(`  Uploading audio file...`));
        await uploadToGCS(combinedPath, `${GCS_BUCKET}/${gcsPath}/${outputBase}.m4a`, 'audio/mp4');
        console.log(chalk.green(`  ✓ ${outputBase}.m4a`));

        // Upload thumbnail
        console.log(chalk.gray(`  Uploading thumbnail...`));
        await uploadToGCS(thumbnailPath, `${GCS_BUCKET}/${gcsPath}/thumbnail.png`, 'image/png');
        console.log(chalk.green(`  ✓ thumbnail.png`));

        // Upload ALL images from chapters and track their GCS URLs with descriptions
        // This includes the chapter artwork image AND all other images in each chapter
        const chapterImageUrls: Map<number, string> = new Map(); // For chapter artwork
        const allChapterImages: Map<number, ChapterImageData[]> = new Map(); // All images per chapter

        // Collect all unique images per chapter
        const allImageUrlsToUpload = new Set<string>();
        const imageUrlToChapterIndices = new Map<string, number[]>();

        for (let i = 0; i < contentForHtmlPages.chapters.length; i++) {
            const chapter = contentForHtmlPages.chapters[i];
            allChapterImages.set(i, []);
            for (const imgUrl of chapter.images) {
                // Only include images that have descriptions (not skipped)
                if (imageDescriptions.has(imgUrl)) {
                    allImageUrlsToUpload.add(imgUrl);
                    const indices = imageUrlToChapterIndices.get(imgUrl) || [];
                    indices.push(i);
                    imageUrlToChapterIndices.set(imgUrl, indices);
                }
            }
        }

        // Upload images and build GCS URL mapping
        const imageUrlToGcsUrl = new Map<string, string>();
        if (allImageUrlsToUpload.size > 0) {
            console.log(chalk.gray(`  Uploading ${allImageUrlsToUpload.size} article images...`));
            let imgIndex = 0;
            for (const imgUrl of allImageUrlsToUpload) {
                imgIndex++;
                try {
                    const response = await fetchWithUA(imgUrl);
                    if (response.ok) {
                        const contentType = response.headers.get('content-type') || 'image/jpeg';
                        const ext = contentType.includes('png') ? 'png'
                            : contentType.includes('gif') ? 'gif'
                            : contentType.includes('webp') ? 'webp'
                            : 'jpg';
                        const imageFilename = `image-${String(imgIndex).padStart(2, '0')}.${ext}`;
                        const imagePath = path.join(outputDir, 'images', imageFilename);
                        const arrayBuffer = await response.arrayBuffer();
                        await Bun.write(imagePath, Buffer.from(arrayBuffer));

                        const gcsImagePath = `${GCS_BUCKET}/${gcsPath}/images/${imageFilename}`;
                        await uploadToGCS(imagePath, gcsImagePath, contentType);

                        const gcsUrl = `${GCS_BASE_URL}/${gcsPath}/images/${imageFilename}`;
                        imageUrlToGcsUrl.set(imgUrl, gcsUrl);
                        console.log(chalk.green(`  ✓ ${imageFilename}`));
                    }
                } catch {
                    console.log(chalk.yellow(`  ⚠ Could not upload image ${imgIndex}`));
                }
            }
        }

        // Build chapter image data with GCS URLs
        for (let i = 0; i < contentForHtmlPages.chapters.length; i++) {
            const chapter = contentForHtmlPages.chapters[i];
            const chapterImages: ChapterImageData[] = [];

            for (const imgUrl of chapter.images) {
                const gcsUrl = imageUrlToGcsUrl.get(imgUrl);
                const description = imageDescriptions.get(imgUrl);
                if (gcsUrl && description) {
                    chapterImages.push({ gcsUrl, description });

                    // Set first image as chapter artwork
                    if (!chapterImageUrls.has(i)) {
                        chapterImageUrls.set(i, gcsUrl);
                    }
                }
            }
            allChapterImages.set(i, chapterImages);
        }

        // Generate and upload chapter HTML pages
        console.log(chalk.gray(`  Generating chapter HTML pages...`));
        const chapterPageUrls: Map<number, string> = new Map();
        const allChapterPageInfo = chapters.map((c, i) => ({
            title: c.title,
            pageUrl: `${GCS_BASE_URL}/${gcsPath}/chapter-${i + 1}.html`,
        }));

        for (let i = 0; i < chapters.length; i++) {
            const chapter = chapters[i];
            const originalChapter = contentForHtmlPages.chapters[i];

            // Build images array with original URL, GCS URL, and description
            const imagesForHtml = originalChapter.images
                .map(originalUrl => {
                    const gcsUrl = imageUrlToGcsUrl.get(originalUrl);
                    const description = imageDescriptions.get(originalUrl);
                    if (gcsUrl && description) {
                        return { originalUrl, gcsUrl, description };
                    }
                    return null;
                })
                .filter((img): img is { originalUrl: string; gcsUrl: string; description: string } => img !== null);

            const chapterHtml = generateChapterHtml({
                episodeTitle: content.title,
                chapterTitle: chapter.title,
                content: originalChapter.content,
                images: imagesForHtml,
                chapterIndex: i,
                totalChapters: chapters.length,
                sourceUrl: url,
                allChapters: allChapterPageInfo,
            });

            const chapterHtmlFilename = `chapter-${i + 1}.html`;
            const chapterHtmlPath = path.join(outputDir, chapterHtmlFilename);
            await Bun.write(chapterHtmlPath, chapterHtml);

            const gcsHtmlPath = `${GCS_BUCKET}/${gcsPath}/${chapterHtmlFilename}`;
            await uploadToGCS(chapterHtmlPath, gcsHtmlPath, 'text/html');

            const chapterPageUrl = `${GCS_BASE_URL}/${gcsPath}/${chapterHtmlFilename}`;
            chapterPageUrls.set(i, chapterPageUrl);
            console.log(chalk.green(`  ✓ ${chapterHtmlFilename}`));
        }

        // Generate and upload RSS feed
        console.log(chalk.gray(`  Generating RSS feed...`));
        const audioUrl = `${GCS_BASE_URL}/${gcsPath}/${outputBase}.m4a`;
        const thumbnailUrl = `${GCS_BASE_URL}/${gcsPath}/thumbnail.png`;
        const jsonChaptersUrl = `${GCS_BASE_URL}/${gcsPath}/podcast-chapters.json`;

        // Get audio file size for enclosure
        const audioStats = Bun.file(combinedPath).size;

        // Build chapters with image URLs and page URLs for RSS
        const chaptersForRss = chapters.map((c, i) => ({
            title: c.title,
            startMs: c.startMs,
            imageUrl: chapterImageUrls.get(i),
            pageUrl: chapterPageUrls.get(i),
            images: allChapterImages.get(i),
        }));

        // Build enhanced description with image references
        const descriptionChapters = chapters.map((c, i) => ({
            title: c.title,
            startMs: c.startMs,
            images: allChapterImages.get(i) || [],
        }));
        const enhancedSummary = buildDescriptionWithImages(summary, descriptionChapters);

        // Generate Podcasting 2.0 JSON chapters file
        const jsonChapters = generateJsonChapters(chaptersForRss, url);
        const jsonChaptersPath = path.join(outputDir, 'podcast-chapters.json');
        await Bun.write(jsonChaptersPath, JSON.stringify(jsonChapters, null, 2));
        console.log(chalk.green(`  ✓ podcast-chapters.json (local)`));

        // Upload JSON chapters
        await uploadToGCS(jsonChaptersPath, `${GCS_BUCKET}/${gcsPath}/podcast-chapters.json`, 'application/json+chapters');
        console.log(chalk.green(`  ✓ podcast-chapters.json (uploaded)`));

        const rssFeed = generateRssFeed({
            title: content.title,
            author: content.byline || 'Read To Me',
            summary: enhancedSummary,
            sourceUrl: url,
            audioUrl,
            thumbnailUrl,
            audioSizeBytes: audioStats,
            durationMs: currentTime,
            chapters: chaptersForRss,
            chaptersJsonUrl: jsonChaptersUrl,
        });

        const rssFeedPath = path.join(outputDir, 'feed.xml');
        await Bun.write(rssFeedPath, rssFeed);
        console.log(chalk.green(`  ✓ feed.xml (local)`));

        // Upload RSS feed with correct content type
        await uploadToGCS(rssFeedPath, `${GCS_BUCKET}/${gcsPath}/feed.xml`, 'application/rss+xml');
        console.log(chalk.green(`  ✓ feed.xml (uploaded)`));

        // Update master feed with all episodes
        console.log(chalk.gray(`  Updating master feed...`));
        const masterFeedUrl = `${GCS_BASE_URL}/read-to-me/feed.xml`;

        const newEpisode: EpisodeData = {
            title: content.title,
            author: content.byline || 'Read To Me',
            summary: enhancedSummary,
            sourceUrl: url,
            audioUrl,
            thumbnailUrl,
            audioSizeBytes: audioStats,
            durationMs: currentTime,
            pubDate: new Date().toUTCString(),
            chapters: chaptersForRss,
        };

        const masterFeed = await updateMasterFeed(masterFeedUrl, newEpisode);
        const masterFeedPath = path.join(outputDir, 'master-feed.xml');
        await Bun.write(masterFeedPath, masterFeed);

        // Upload master feed with correct content type
        await uploadToGCS(masterFeedPath, `${GCS_BUCKET}/read-to-me/feed.xml`, 'application/rss+xml');
        console.log(chalk.green(`  ✓ master feed.xml (uploaded)`));

        podcastUrl = masterFeedUrl;
    }

    console.log();
    console.log(style.header('Done!'));
    console.log(`  Total duration: ${formatMs(currentTime)}`);
    console.log(`  Output: ${combinedPath}`);
    if (podcastUrl) {
        console.log();
        console.log(chalk.cyan.bold(`  🎧 Podcast RSS Feed:`));
        console.log(chalk.cyan(`     ${podcastUrl}`));
        console.log();
        console.log(chalk.gray(`  Add this URL to Overcast or any podcast app to subscribe.`));
    }
});
