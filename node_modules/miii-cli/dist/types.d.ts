export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type Status = 'idle' | 'streaming' | 'tool';
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
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export declare function generateId(): string;
