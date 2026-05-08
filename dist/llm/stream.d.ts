import type { ChatMessage } from '../types.js';
export interface ChatConfig {
    provider: 'ollama' | 'openai-compat';
    model: string;
    baseUrl: string;
    apiKey?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    onDone: (fullText: string) => void | Promise<void>;
    onError: (err: Error) => void;
    onUsage?: (promptTokens: number, completionTokens: number) => void;
}
export declare function chat(cfg: ChatConfig): Promise<void>;
