import type { ChatMessage } from './types.js';
export declare function listSessions(): Array<{
    name: string;
    messageCount: number;
    updatedAt: number;
}>;
export declare function loadSession(name: string): ChatMessage[];
export declare function saveSession(name: string, messages: ChatMessage[]): void;
export declare function deleteSession(name: string): void;
