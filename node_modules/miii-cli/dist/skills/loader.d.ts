export interface SkillContext {
    messages: Array<{
        role: string;
        content: string;
    }>;
    appendMessage: (role: string, content: string) => void;
    setSystemPrompt: (p: string) => void;
    getSystemPrompt: () => string;
}
export interface Skill {
    name: string;
    ns: string;
    description: string;
    prompt?: string;
    execute?: (args: string, ctx: SkillContext) => string | Promise<string>;
}
export declare class SkillLoader {
    private map;
    constructor();
    loadAll(): Promise<void>;
    get(ref: string): Skill | undefined;
    list(): Skill[];
}
