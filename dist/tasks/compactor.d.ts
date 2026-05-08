import type { ChatMessage } from '../types.js';
export declare function shouldCompact(messages: ChatMessage[]): boolean;
/**
 * Compact context to keep local models on track during long refactors.
 *
 * Strategy:
 *   1. Keep system prompt (index 0)
 *   2. Keep first user message (original goal)
 *   3. Summarise completed tool results in the middle into one message
 *   4. Keep last KEEP_RECENT messages verbatim (model's working memory)
 */
export declare function compactContext(messages: ChatMessage[], goal?: string): ChatMessage[];
/**
 * Build a fresh isolated context for a single-file edit step.
 * Keeps context tiny — avoids cross-file noise polluting the model.
 */
export declare function fileEditContext(systemPrompt: string, goal: string, filePath: string, fileContent: string, instruction: string): ChatMessage[];
