const COMPACT_THRESHOLD = 18; // compact when context exceeds this many messages
const KEEP_RECENT = 6; // always keep last N messages verbatim
export function shouldCompact(messages) {
    return messages.length > COMPACT_THRESHOLD;
}
/**
 * Compact context to keep local models on track during long refactors.
 *
 * Strategy:
 *   1. Keep system prompt (index 0)
 *   2. Keep first user message (original goal)
 *   3. Summarise completed tool results in the middle into one message
 *   4. Keep last KEEP_RECENT messages verbatim (model's working memory)
 */
export function compactContext(messages, goal) {
    if (messages.length <= COMPACT_THRESHOLD)
        return messages;
    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const userGoal = messages.find(m => m.role === 'user' && !m.content.startsWith('['));
    const anchorCount = (system ? 1 : 0) + (userGoal ? 1 : 0);
    const middle = messages.slice(anchorCount, messages.length - KEEP_RECENT);
    const recent = messages.slice(messages.length - KEEP_RECENT);
    const toolResults = middle
        .filter(m => m.role === 'user' && m.content.startsWith('Tool '))
        .map(m => {
        const lines = m.content.split('\n');
        return `• ${lines[0]}`; // just the "Tool X result:" line
    });
    const assistantSummaries = middle
        .filter(m => m.role === 'assistant' && m.content.trim().length > 0)
        .map(m => m.content.slice(0, 120).replace(/\n/g, ' '));
    const parts = [`[context compacted — ${middle.length} messages summarised]`];
    if (goal)
        parts.push(`Goal: ${goal}`);
    if (toolResults.length)
        parts.push(`Completed:\n${toolResults.join('\n')}`);
    if (assistantSummaries.length)
        parts.push(`Last reasoning: ${assistantSummaries.at(-1)}`);
    const summary = { role: 'user', content: parts.join('\n\n') };
    return [
        ...(system ? [system] : []),
        ...(userGoal ? [userGoal] : []),
        summary,
        ...recent,
    ];
}
/**
 * Build a fresh isolated context for a single-file edit step.
 * Keeps context tiny — avoids cross-file noise polluting the model.
 */
export function fileEditContext(systemPrompt, goal, filePath, fileContent, instruction) {
    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                `Overall goal: ${goal}`,
                ``,
                `File to edit: ${filePath}`,
                `<file>`,
                fileContent,
                `</file>`,
                ``,
                `Instruction: ${instruction}`,
            ].join('\n'),
        },
    ];
}
//# sourceMappingURL=compactor.js.map