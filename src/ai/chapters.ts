import chalk from 'chalk';
import path from 'path';
import { generateText } from 'ai';
import { withRetry } from '../utils/retry';
import { geminiFlashModel } from '../clients';
import { PROMPTS_DIR } from '../constants';
import { extractImagesFromMarkdown } from '../content';
import type { Chapter, ExtractedContent } from '../types';

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'chapter-suggestion.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Chapter suggestion prompt not found at: ${promptPath}`);
    }
    return file.text();
}

function normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findStartIndex(fullContent: string, startPhrase: string): number {
    // 1. Try exact match
    let index = fullContent.indexOf(startPhrase);
    if (index !== -1) return index;

    // 2. Try case-insensitive match
    const lowerContent = fullContent.toLowerCase();
    const lowerPhrase = startPhrase.toLowerCase();
    index = lowerContent.indexOf(lowerPhrase);
    if (index !== -1) return index;

    // 3. Try normalized whitespace match
    const normalizedContent = normalizeText(fullContent);
    const normalizedPhrase = normalizeText(startPhrase);
    const normalizedIndex = normalizedContent.indexOf(normalizedPhrase);
    if (normalizedIndex !== -1) {
        // Map back to original position by counting characters
        let origPos = 0;
        let normPos = 0;
        while (normPos < normalizedIndex && origPos < fullContent.length) {
            if (/\s/.test(fullContent[origPos])) {
                // Skip whitespace sequences in original, they become single space in normalized
                while (origPos < fullContent.length && /\s/.test(fullContent[origPos])) origPos++;
                normPos++; // Single space in normalized
            } else {
                origPos++;
                normPos++;
            }
        }
        return origPos;
    }

    // 4. Try word-based fuzzy match - find longest consecutive word sequence
    const words = startPhrase.split(/\s+/).filter(w => w.length > 2);
    if (words.length >= 3) {
        // Try progressively shorter sequences starting from the beginning
        for (let len = words.length; len >= 3; len--) {
            const searchWords = words.slice(0, len);
            const pattern = searchWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
            const regex = new RegExp(pattern, 'i');
            const match = regex.exec(fullContent);
            if (match) return match.index;
        }
    }

    return -1;
}

export async function suggestChapters(content: ExtractedContent): Promise<ExtractedContent> {
    // Combine all content to analyze as a whole
    const fullContent = content.chapters.map(c => c.content).join('\n\n');

    // Skip for very short content
    if (fullContent.length < 1000) {
        console.log(chalk.gray('  Content too short for chapter analysis'));
        return content;
    }

    console.log(chalk.blue('Analyzing content for chapter suggestions...'));

    try {
        const prompt = await loadPrompt();
        const result = await withRetry(
            async () => generateText({
                model: geminiFlashModel,
                prompt: `${prompt}\n\nCONTENT TO ANALYZE:\n---\n${fullContent}\n---`,
            }),
            'suggest chapters'
        );

        let responseText = result.text.trim();
        // Remove markdown code block wrapping if present
        responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

        const suggestions = JSON.parse(responseText) as Array<{ title: string; startPhrase: string }>;

        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            console.log(chalk.yellow('  No chapter suggestions returned'));
            return content;
        }

        console.log(chalk.green(`  AI suggested ${suggestions.length} chapters`));

        // Build new chapters based on suggestions
        // First pass: find all valid start positions
        const validSuggestions: Array<{ title: string; startIndex: number }> = [];
        for (const suggestion of suggestions) {
            const startIndex = findStartIndex(fullContent, suggestion.startPhrase);
            if (startIndex === -1) {
                console.log(chalk.yellow(`  Could not find start phrase for "${suggestion.title}", skipping`));
                continue;
            }
            validSuggestions.push({ title: suggestion.title, startIndex });
        }

        // Sort by position to ensure correct order
        validSuggestions.sort((a, b) => a.startIndex - b.startIndex);

        // Second pass: build chapters with correct boundaries
        const newChapters: Chapter[] = [];
        for (let i = 0; i < validSuggestions.length; i++) {
            const current = validSuggestions[i];
            const next = validSuggestions[i + 1];

            const startIndex = current.startIndex;
            const endIndex = next ? next.startIndex : fullContent.length;

            const chapterContent = fullContent.slice(startIndex, endIndex).trim();

            newChapters.push({
                title: current.title,
                content: chapterContent,
                images: extractImagesFromMarkdown(chapterContent),
            });

            console.log(chalk.gray(`    - ${current.title} (${chapterContent.length} chars)`));
        }

        // If we couldn't build any chapters from suggestions, keep original
        if (newChapters.length === 0) {
            console.log(chalk.yellow('  Could not create chapters from suggestions, keeping original'));
            return content;
        }

        return { ...content, chapters: newChapters };
    } catch (err) {
        console.log(chalk.yellow(`  Chapter suggestion failed: ${(err as Error).message}`));
        console.log(chalk.gray('  Keeping original chapter structure'));
        return content;
    }
}
