import type { SkillLoader } from '../skills/loader.js';
import type { Config } from '../types.js';
interface Props {
    config: Config;
    skills: SkillLoader;
    cwd: string;
}
export declare function InputBar({ config, skills, cwd }: Props): import("react/jsx-runtime").JSX.Element;
export {};
