import type { OllamaModel } from '../../llm/ollama.js';
interface PullState {
    name: string;
    status: string;
    pct: number | undefined;
}
interface Props {
    models: OllamaModel[];
    current: string;
    loading: boolean;
    error?: string;
    pull?: PullState;
    onSelect: (name: string) => void;
    onPull: (name: string) => void;
    onClose: () => void;
}
export declare function ModelPicker({ models, current, loading, error, pull, onSelect, onPull, onClose }: Props): import("react/jsx-runtime").JSX.Element;
export {};
