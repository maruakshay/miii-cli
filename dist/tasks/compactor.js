import { chat } from '../llm/stream.js';
// ~4 chars per token heuristic. 40K chars ≈ 10K tokens — safe floor for 7B local models.
// Cloud providers can handle more but compacting early keeps responses fast regardless.
const COMPACT_CHAR_THRESHOLD = 40_000;
const KEEP_RECENT = 6;
export function contextSize(messages) {
    return messages.reduce((sum, m) => sum + m.content.length, 0);
}
export function shouldCompact(messages) {
    return contextSize(messages) > COMPACT_CHAR_THRESHOLD;
}
const COMPACT_SYSTEM = `You are a context summarizer for an AI coding agent session.
Your job: produce a dense, structured summary of the conversation so the agent can continue the task without losing context.

Output format (use exactly these headers):

## Task
One sentence: what the user asked for.

## Completed
Bullet list of actions taken (files edited, commands run, decisions made). Be specific — include file paths and outcomes.

## Current State
What is true right now: which files were changed, what tests showed, what is working or broken.

## Remaining
What still needs to be done, if anything.

## Key Context
Any constraints, errors encountered, important facts the agent must remember to continue correctly.

Be factual. No padding. Include file paths, error messages, and command outputs verbatim when relevant.`;
export async function compactContext(messages, cfg, goal, signal) {
    if (contextSize(messages) <= COMPACT_CHAR_THRESHOLD)
        return messages;
    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const recent = messages.slice(messages.length - KEEP_RECENT);
    const toSummarize = messages.slice(system ? 1 : 0, messages.length - KEEP_RECENT);
    // Build conversation transcript for the summarizer
    const transcript = toSummarize.map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : 'User';
        const body = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n[truncated]' : m.content;
        return `### ${role}\n${body}`;
    }).join('\n\n');
    const userPrompt = [
        goal ? `The user's goal: ${goal}\n` : '',
        `Conversation to summarize:\n\n${transcript}`,
    ].join('');
    let summary = '';
    let compactErr = '';
    await chat({
        ...cfg,
        signal,
        messages: [
            { role: 'system', content: COMPACT_SYSTEM },
            { role: 'user', content: userPrompt },
        ],
        onDone: (text) => { summary = text.trim(); },
        onError: (err) => { compactErr = err.message; },
    });
    if (compactErr)
        console.error(`[compactor] LLM error: ${compactErr}`);
    if (signal?.aborted)
        return messages;
    // Fallback to dumb compaction if LLM fails
    if (!summary)
        return dumbCompact(messages, goal);
    const summaryMsg = {
        role: 'user',
        content: `[Context compacted — ${toSummarize.length} messages summarised]\n\n${summary}`,
    };
    const needsBridge = recent.length > 0 && recent[0].role === 'user';
    const bridgeMsg = { role: 'assistant', content: 'Understood. Continuing from the summarized context.' };
    return [
        ...(system ? [system] : []),
        summaryMsg,
        ...(needsBridge ? [bridgeMsg] : []),
        ...recent,
    ];
}
function dumbCompact(messages, goal) {
    if (contextSize(messages) <= COMPACT_CHAR_THRESHOLD)
        return messages;
    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const userGoal = messages.find(m => m.role === 'user' && !m.content.startsWith('['));
    const recent = messages.slice(messages.length - KEEP_RECENT);
    const middle = messages.slice((system ? 1 : 0) + (userGoal ? 1 : 0), messages.length - KEEP_RECENT);
    const toolResults = middle
        .filter(m => m.role === 'user' && m.content.startsWith('Tool '))
        .map(m => `• ${m.content.split('\n')[0]}`);
    const parts = [`[context compacted — ${middle.length} messages summarised]`];
    if (goal)
        parts.push(`Goal: ${goal}`);
    if (toolResults.length)
        parts.push(`Completed:\n${toolResults.join('\n')}`);
    return [
        ...(system ? [system] : []),
        ...(userGoal ? [userGoal] : []),
        { role: 'user', content: parts.join('\n\n') },
        ...recent,
    ];
}
/**
 * Build a fresh isolated context for a single-file edit step.
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
