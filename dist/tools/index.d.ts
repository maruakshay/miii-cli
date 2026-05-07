export interface Tool {
    name: string;
    description: string;
    params: string;
    execute: (args: Record<string, unknown>) => Promise<string>;
}
export declare const tools: Tool[];
export declare function getSystemPrompt(extra?: string): string;
