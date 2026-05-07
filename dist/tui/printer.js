// ANSI-formatted stdout output — goes into terminal scrollback
const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
function bold(s) { return `${BOLD}${s}${R}`; }
function dim(s) { return `${DIM}${s}${R}`; }
function col(code, s) { return `\x1b[${code}m${s}${R}`; }
const blue = (s) => col(94, s);
const green = (s) => col(92, s);
const cyan = (s) => col(96, s);
const gray = (s) => col(90, s);
const yellow = (s) => col(93, s);
function indent(text, pad = '  ') {
    return text.split('\n').map(l => pad + l).join('\n');
}
function formatContent(text) {
    const lines = text.split('\n');
    let inCode = false;
    const out = [];
    for (const line of lines) {
        if (line.startsWith('<tool_call>') || line.startsWith('</tool_call>'))
            continue;
        if (line.startsWith('```')) {
            inCode = !inCode;
            out.push('  ' + dim(gray(line)));
        }
        else if (inCode) {
            out.push('  ' + yellow(line || ' '));
        }
        else {
            out.push('  ' + (line || ''));
        }
    }
    return out.join('\n');
}
export function welcome(provider, model, cwd) {
    const cols = process.stdout.columns ?? 80;
    process.stdout.write(`${bold(cyan('MIII'))}  ${gray(`${provider}/${model}  ·  ${cwd}`)}\n`);
    process.stdout.write(`${gray('─'.repeat(cols))}\n`);
}
export function userMsg(text) {
    const atHighlighted = text.replace(/(@[\w./\-]+)/g, (m) => cyan(m));
    console.log(`\n${bold(blue('You'))}\n${indent(atHighlighted)}`);
}
export function assistantMsg(text) {
    console.log(`\n${bold(green('miii'))}\n${formatContent(text)}`);
}
export function toolMsg(name, result) {
    const preview = result.length > 250 ? result.slice(0, 250) + '…' : result;
    const body = preview.trim()
        ? preview.split('\n').map(l => gray('    ' + l)).join('\n')
        : '';
    console.log(`  ${green('✓')} ${cyan(name)}${body ? '\n' + body : ''}`);
}
export function systemMsg(text) {
    console.log(gray(`─ ${text}`));
}
export function errorMsg(text) {
    console.log(gray(`error: ${text}`));
}
export function divider() {
    const cols = process.stdout.columns ?? 80;
    process.stdout.write(`${gray('─'.repeat(cols))}\n`);
}
//# sourceMappingURL=printer.js.map