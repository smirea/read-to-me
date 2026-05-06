const INTERACTION_REMINDER_PATTERNS: RegExp[] = [
    /\bdon['’]?t forget to\s+(?:like|subscribe|follow|rate|review|share|comment)\b/i,
    /\b(?:like|subscribe|follow)\s+(?:to|for)\s+(?:the\s+)?(?:show|podcast|channel)\b/i,
    /\b(?:rate|review)\s+(?:the\s+)?(?:show|podcast)\b/i,
    /\bleave\s+(?:us\s+)?(?:a\s+)?(?:rating|review)\b/i,
    /\b(?:five|5)\s*star\s+review\b/i,
    /\bturn on notifications\b/i,
    /\bsmash\s+(?:that\s+)?(?:like|subscribe)\b/i,
    /\bjoin\s+(?:our|the)\s+(?:patreon|substack|newsletter|discord|community)\b/i,
    /\bsupport\s+(?:the\s+)?(?:show|podcast|us)\s+(?:on\s+)?(?:patreon|substack|paypal|bitcoin|buy me a coffee)\b/i,
    /\bfollow us on\b/i,
    /\blink(?:s)?\s+(?:are|is)\s+in\s+(?:the\s+)?(?:description|show notes)\b/i,
    /\bshare\s+(?:this|the)\s+(?:show|episode)\b/i,
    /\btell a friend\b/i,
];

export function isInteractionReminderText(text: string): boolean {
    if (!text) return false;
    const normalized = text.replace(/\s+/g, ' ').trim();
    return INTERACTION_REMINDER_PATTERNS.some(pattern => pattern.test(normalized));
}
