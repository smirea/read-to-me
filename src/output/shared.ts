export function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function escapeMetadata(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/=/g, '\\=')
        .replace(/;/g, '\\;')
        .replace(/#/g, '\\#')
        .replace(/\n/g, '\\\n');
}

export function cdata(text: string): string {
    return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}
