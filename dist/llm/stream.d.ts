import type { ChatMessage } from '../types.js';
export interface StreamConfig {
    provider: 'ollama' | 'openai-compat';
    model: string;
    baseUrl: string;
    apiKey?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    onToken: (token: string) => void;
    onDone: (fullText: string) => void | Promise<void>;
    onError: (err: Error) => void;
}
export declare function stream(cfg: StreamConfig): Promise<void>;
