export interface ParsedText {
    type: 'text';
    content: string;
}
export interface ParsedTool {
    type: 'tool_call';
    content: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
}
export type ParsedItem = ParsedText | ParsedTool;
export declare class StreamParser {
    private buf;
    private inTool;
    feed(token: string): ParsedItem[];
    flush(): ParsedItem[];
}
