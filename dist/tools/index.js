import { readFile, writeFile, deleteFile, listFiles } from '../files/ops.js';
import { exec } from 'child_process';
import { promisify } from 'util';
const run = promisify(exec);
export const tools = [
    {
        name: 'read_file',
        description: 'Read file contents',
        params: '{"path": "string"}',
        execute: async ({ path }) => {
            try {
                return readFile(path);
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
            const entries = listFiles(path, recursive);
            if (!entries.length)
                return '(empty)';
            return entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.rel}`).join('\n');
        },
    },
    {
        name: 'edit_file',
        description: 'Write/overwrite file content',
        params: '{"path": "string", "content": "string"}',
        execute: async ({ path, content }) => {
            writeFile(path, content);
            return `written: ${path}`;
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file',
        params: '{"path": "string"}',
        execute: async ({ path }) => {
            deleteFile(path);
            return `deleted: ${path}`;
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in cwd',
        params: '{"command": "string"}',
        execute: async ({ command }) => {
            const { stdout, stderr } = await run(command, { cwd: process.cwd() });
            return [stdout, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('\n').trim();
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

Tools:
${toolDocs}

Rules:
- Read files before editing
- Show unified diff when editing (for context)
- Never delete without confirming
- Be concise${extra}`;
}
//# sourceMappingURL=index.js.map