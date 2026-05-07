import type { Skill } from '../../skills/loader.js';
interface Props {
    skills: Skill[];
    query: string;
    idx: number;
}
export declare function CommandPalette({ skills, query, idx }: Props): import("react/jsx-runtime").JSX.Element;
export {};
