export declare function readFile(p: string): string;
export declare function writeFile(p: string, content: string): void;
export declare function deleteFile(p: string): void;
export declare function createDir(p: string): void;
export declare function moveFile(from: string, to: string): void;
export interface FileEntry {
    name: string;
    path: string;
    rel: string;
    type: 'file' | 'dir';
    size?: number;
}
export declare function listFiles(dir: string, recursive?: boolean, cwd?: string): FileEntry[];
