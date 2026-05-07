export interface OllamaModel {
    name: string;
    size: number;
    modified_at: string;
    digest?: string;
}
export declare function listModels(baseUrl: string): Promise<OllamaModel[]>;
export declare function pullModel(baseUrl: string, name: string, onProgress: (status: string, pct: number | undefined) => void, signal?: AbortSignal): Promise<void>;
export declare function fmtSize(bytes: number): string;
