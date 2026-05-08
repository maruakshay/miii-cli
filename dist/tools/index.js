import { readFile, writeFile, deleteFile, listFiles, createDir, moveFile, guardPath } from '../files/ops.js';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
const run = promisify(exec);
const EXEC_TIMEOUT_MS = 30_000;
export const tools = [
    {
        name: 'read_file',
        description: 'Read file contents',
        params: '{"path": "string"}',
        execute: async ({ path }) => {
            try {
                return readFile(guardPath(path));
            }
            catch (e) {
                throw new Error(`read_file: ${e}`);
            }
        },
    },
    {
        name: 'list_files',
        description: 'List directory contents',
        params: '{"path": "string", "recursive": "boolean (optional)"}',
        execute: async ({ path, recursive = false }) => {
            const entries = listFiles(guardPath(path), recursive);
            if (!entries.length)
                return '(empty)';
            return entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.rel}`).join('\n');
        },
    },
    {
        name: 'create_file',
        description: 'Create a new file — fails if file already exists',
        params: '{"path": "string", "content": "string"}',
        execute: async ({ path, content }) => {
            const safe = guardPath(path);
            if (existsSync(safe))
                throw new Error(`file already exists: ${path}`);
            writeFile(safe, content);
            return `created: ${path}`;
        },
    },
    {
        name: 'edit_file',
        description: 'Overwrite entire file — use only for new files or full rewrites',
        params: '{"path": "string", "content": "string"}',
        execute: async ({ path, content }) => {
            writeFile(guardPath(path), content);
            return `written: ${path}`;
        },
    },
    {
        name: 'patch_file',
        description: 'Replace an exact string in a file — use for targeted edits to existing files',
        params: '{"path": "string", "old": "string", "new": "string"}',
        execute: async ({ path, old: oldStr, new: newStr }) => {
            const safe = guardPath(path);
            const current = readFile(safe);
            if (!current)
                throw new Error(`file not found or empty: ${path}`);
            if (!current.includes(oldStr))
                throw new Error(`old text not found in ${path}`);
            const updated = current.replace(oldStr, newStr);
            writeFile(safe, updated);
            return `patched: ${path}`;
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file',
        params: '{"path": "string"}',
        execute: async ({ path }) => {
            deleteFile(guardPath(path));
            return `deleted: ${path}`;
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in cwd',
        params: '{"command": "string"}',
        execute: async ({ command }) => {
            const { stdout, stderr } = await run(command, { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS });
            return [stdout, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('\n').trim();
        },
    },
    {
        name: 'create_folder',
        description: 'Create a directory (and any missing parents)',
        params: '{"path": "string"}',
        execute: async ({ path }) => {
            createDir(guardPath(path));
            return `created: ${path}`;
        },
    },
    {
        name: 'move_file',
        description: 'Move or rename a file or directory',
        params: '{"from": "string", "to": "string"}',
        execute: async ({ from, to }) => {
            moveFile(guardPath(from), guardPath(to));
            return `moved: ${from} → ${to}`;
        },
    },
];
export function getSystemPrompt(extra = '') {
    const toolDocs = tools.map(t => `- ${t.name}(${t.params}): ${t.description}`).join('\n');
    return `You are Miii — a fast, local AI coding assistant.

Use tools by emitting:
<tool_call>
{"name": "tool_name", "args": {...}}
</tool_call>

Put file content in named blocks (never inside JSON — avoids escaping errors):

For edit_file / create_file use <content> block:
<tool_call>
{"name": "edit_file", "args": {"path": "src/foo.ts"}}
<content>
full file content here
</content>
</tool_call>

For patch_file use <old> and <new> blocks:
<tool_call>
{"name": "patch_file", "args": {"path": "src/foo.ts"}}
<old>
exact text to replace
</old>
<new>
replacement text
</new>
</tool_call>

Tools:
${toolDocs}

Rules:
- To modify an existing file: use patch_file with the exact old text and new replacement — do NOT rewrite the whole file
- To create a new file: use edit_file with full content in the <content> block
- read_file before patch_file so you know the exact text to match
- Never delete without confirming
- Be concise
- Output plain text only — never use markdown formatting in your responses
- No headers (no #, ##), no bold (**text**), no italic (*text*), no bullet points with *, no horizontal rules (---)
- No fenced code blocks with backticks in prose
- Use plain indentation and labels for structure. This is a terminal, not a chat UI${extra}`;
}
//# sourceMappingURL=index.js.map