/**
 * Format milliseconds to HH:MM:SS string.
 */
export function formatMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatChapterTime(ms: number): string {
    const totalMs = Math.max(0, Math.floor(ms));
    const totalSeconds = Math.floor(totalMs / 1000);
    const milliseconds = totalMs % 1000;
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

/**
 * Parse HH:MM:SS time string to milliseconds.
 */
export function parseTimeToMs(timeStr: string): number {
    const trimmed = String(timeStr ?? '').trim();
    if (!trimmed) return 0;

    const parts = trimmed.split(':');
    if (parts.length < 2 || parts.length > 3) return 0;

    const [hRaw, mRaw, sRaw] = parts.length === 3 ? parts : ['0', parts[0], parts[1]];
    const hours = Number.parseInt(hRaw, 10);
    const minutes = Number.parseInt(mRaw, 10);

    const sParts = sRaw.split('.');
    const seconds = Number.parseInt(sParts[0] || '0', 10);
    const ms = Number.parseInt((sParts[1] || '0').padEnd(3, '0').slice(0, 3), 10);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(ms)) return 0;
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + ms;
}
