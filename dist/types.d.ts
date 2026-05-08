export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type Status = 'idle' | 'thinking' | 'tool';
export interface Message {
    id: string;
    role: Role;
    content: string;
    timestamp: number;
}
export interface Config {
    model: string;
    provider: 'ollama' | 'openai-compat';
    baseUrl: string;
    systemPrompt?: string;
    apiKey?: string;
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export declare function generateId(): string;
