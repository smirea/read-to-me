function stripBareUrls(text: string): string {
    return text
        .replace(/<https?:\/\/[^>]+>/g, '')
        .replace(/https?:\/\/[^\s<>[\]"']+/g, '');
}

function stripMarkdownLinks(text: string): string {
    return text
        .replace(/\[([^\]]*)\]\((?:[^()]*|\([^()]*\))*\)/g, '$1')
        .replace(/\[\]\s*/g, '');
}

function stripMarkdownFormatting(text: string): string {
    return text.replace(/[#*_~]/g, '');
}

export function cleanTextForTTS(content: string): string {
    return stripMarkdownFormatting(
        stripBareUrls(
            stripMarkdownLinks(
                content
                    .replace(/```[\s\S]*?```/g, '')
                    .replace(/`[^`]+`/g, '')
                    .replace(/\s+([.,!?;:])/g, '$1')
                    .replace(/\n{3,}/g, '\n\n')
                    .replace(/  +/g, ' ')
                    .trim()
            )
        )
    );
}

function sanitizeSpokenText(text: string): string {
    return stripMarkdownFormatting(stripBareUrls(stripMarkdownLinks(text))).replace(/_/g, ' ');
}

export function sanitizeTtsChunk(chunk: string, isSsml: boolean): string {
    if (!isSsml) return sanitizeSpokenText(chunk);

    const parts = chunk.split(/(<[^>]+>)/g);
    return parts
        .map(part => (part.startsWith('<') && part.endsWith('>')) ? part : sanitizeSpokenText(part))
        .join('');
}
