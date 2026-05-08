import type { Status } from '../../types.js';
import type { Skill } from '../../skills/loader.js';
interface Props {
    status: Status;
    skills: Skill[];
    cwd: string;
    planningMode?: boolean;
    onSubmit: (text: string) => void;
    onAbort: () => void;
}
export declare function InputArea({ status, skills, cwd, planningMode, onSubmit, onAbort }: Props): import("react/jsx-runtime").JSX.Element;
export {};
