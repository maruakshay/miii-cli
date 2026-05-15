// ANSI-formatted stdout output — goes into terminal scrollback
let _inkWrite = null;
export function setInkInstance(inkWrite) {
    _inkWrite = inkWrite;
}
function write(s) {
    if (_inkWrite) {
        _inkWrite(s);
    }
    else {
        process.stdout.write(s);
    }
}
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
const purple = (s) => col(95, s);
const red = (s) => col(91, s);
function stripMarkdown(s) {
    return s
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6} /gm, '');
}
function formatContent(text) {
    const lines = text.split('\n');
    let inCode = false;
    let inToolCall = false;
    const out = [];
    for (const line of lines) {
        if (line.startsWith('<tool_call>')) {
            inToolCall = true;
            continue;
        }
        if (line.startsWith('</tool_call>')) {
            inToolCall = false;
            continue;
        }
        if (inToolCall)
            continue;
        if (line.startsWith('```')) {
            inCode = !inCode;
            out.push('  ' + dim(gray(line)));
        }
        else if (inCode) {
            out.push('  ' + yellow(line || ' '));
        }
        else {
            out.push('  ' + stripMarkdown(line || ''));
        }
    }
    return out.join('\n');
}
function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
export function toolArgSummary(args) {
    if (args.message)
        return `"${truncate(String(args.message), 60)}"`;
    if (args.path)
        return String(args.path);
    if (args.command)
        return truncate(String(args.command), 60);
    if (args.query)
        return `"${truncate(String(args.query), 60)}"`;
    if (args.from)
        return `${args.from} → ${args.to}`;
    const first = Object.values(args)[0];
    return first ? truncate(String(first), 60) : '';
}
export function welcome(provider, model, cwd, version, updateAvailable, linked) {
    const cols = Math.min(process.stdout.columns ?? 80, 100);
    const innerW = cols - 2;
    const leftW = Math.floor(innerW * 0.44);
    const rightW = innerW - leftW - 1;
    function vis(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
    function cell(s, w) {
        const v = vis(s);
        if (v.length < w)
            return s + ' '.repeat(w - v.length);
        if (v.length === w)
            return s;
        return v.slice(0, w - 1) + '…';
    }
    function row(l, r) {
        return gray('│') + cell(l, leftW) + gray('│') + cell(r, rightW) + gray('│');
    }
    const versionStr = version ? ` v${version}` : '';
    const titleStr = `─ MIII - CLI${versionStr} `;
    const dashCount = Math.max(0, cols - 2 - titleStr.length);
    const top = gray('╭') + gray('─') + bold(cyan(` MIII - CLI${versionStr} `)) + gray('─'.repeat(dashCount) + '╮');
    const bottom = gray('╰' + '─'.repeat(innerW) + '╯');
    const shortCwd = cwd.replace(process.env.HOME ?? '', '~');
    const miniArt = [
        `  ${purple('   ●     ●   ')}`,
        `  ${purple('  ╱ ╲   ╱ ╲  ')}`,
        `  ${purple(' ╱   ╲ ╱   ╲ ')}`,
        `  ${purple('●     ●     ●')}`,
    ];
    const leftLines = [
        '',
        ...miniArt,
        '',
        `  ${gray(model + ' · ' + provider)}`,
        `  ${gray(shortCwd)}`,
        '',
    ];
    const rightLines = [
        '',
        `  ${bold(yellow('Tips for getting started'))}`,
        `  Type ${cyan('@filename')} to inject file into context`,
        `  Use ${cyan('/skill')} to run a skill or command`,
        `  Use ${cyan('/config')} to switch provider, model, or API key`,
        '',
    ];
    const maxLen = Math.max(leftLines.length, rightLines.length);
    const pl = [...leftLines, ...Array(Math.max(0, maxLen - leftLines.length)).fill('')];
    const pr = [...rightLines, ...Array(Math.max(0, maxLen - rightLines.length)).fill('')];
    const contentRows = pl.map((l, i) => row(l, pr[i]));
    const upgradeCmd = linked ? 'cd <miii-dir> && npm run build' : 'npm install -g miii-cli';
    const updateRow = updateAvailable ? (() => {
        const updateText = bold(yellow(` ⬆  update available: v${updateAvailable}  —  run: ${upgradeCmd}`));
        const pad = Math.max(0, innerW - vis(updateText).length);
        const separator = gray('│') + updateText + ' '.repeat(pad) + gray('│');
        return [gray('├' + '─'.repeat(innerW) + '┤'), separator, gray('├' + '─'.repeat(innerW) + '┤')];
    })() : [];
    const lines = [
        top,
        ...contentRows,
        ...updateRow,
        bottom,
    ];
    process.stdout.write(lines.join('\n') + '\n');
}
export function userMsg(text) {
    const atHighlighted = text.replace(/(@[\w./\-]+)/g, (m) => cyan(m));
    write(`\n${gray('>>')} ${atHighlighted}\n`);
}
export function assistantMsg(text) {
    const content = formatContent(text);
    if (!content.trim())
        return;
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trim());
    if (idx === -1)
        return;
    const head = lines[idx].replace(/^ {2}/, '');
    const tail = lines.slice(idx + 1).join('\n');
    write(`\n${blue('●')} ${head}${tail ? '\n' + tail : ''}\n`);
}
const EDIT_TOOLS = new Set(['edit_file', 'patch_file', 'create_file', 'write_file']);
const DELETE_TOOLS = new Set(['delete_file', 'remove_file']);
function toolLabel(name, args) {
    const a = args;
    const short = (s, n = 55) => s.length > n ? s.slice(0, n) + '…' : s;
    switch (name) {
        case 'read_file': return `Reading ${a.path ?? ''}`;
        case 'list_files': return `Listing ${a.path || '.'}`;
        case 'create_file': return `Creating ${a.path ?? ''}`;
        case 'edit_file': return `Writing ${a.path ?? ''}`;
        case 'patch_file': return `Editing ${a.path ?? ''}`;
        case 'delete_file': return `Deleting ${a.path ?? ''}`;
        case 'move_file': return `Moving ${a.from} → ${a.to}`;
        case 'create_folder': return `Creating folder ${a.path ?? ''}`;
        case 'run_command': return `Running ${short(a.command ?? '')}`;
        case 'git_status': return 'Checking git status';
        case 'git_diff': return 'Reading diff';
        case 'git_log': return 'Reading commits';
        case 'git_commit': return `Committing: ${short(a.message ?? '')}`;
        case 'run_tests': return a.path ? `Running tests › ${a.path}` : 'Running tests';
        case 'web_search': return `Searching: ${short(a.query ?? '')}`;
        case 'web_extract': return `Extracting page`;
        case 'deep_think': return `Researching: ${short(a.query ?? '')}`;
        case 'search_codebase': return `Searching codebase: ${short(a.query ?? '')}`;
        default: {
            const s = toolArgSummary(args);
            return s ? `${name} ${s}` : name;
        }
    }
}
export function planSummary(tools) {
    if (!tools.length)
        return;
    const header = gray(`─ plan (${tools.length} action${tools.length === 1 ? '' : 's'})`);
    write(header + '\n');
    for (const t of tools) {
        const dot = DELETE_TOOLS.has(t.name) ? red('◦') : EDIT_TOOLS.has(t.name) ? green('◦') : blue('◦');
        const label = toolLabel(t.name, t.args);
        write(`  ${dot} ${gray(label)}\n`);
    }
}
export function toolCallStart(name, args) {
    const dot = DELETE_TOOLS.has(name) ? red('●') : EDIT_TOOLS.has(name) ? green('●') : blue('●');
    write(`\n${dot} ${bold(toolLabel(name, args))}\n`);
}
export function toolResultSummary(name, args, result) {
    const a = args;
    const lines = result.trim().split('\n').filter(Boolean);
    let summary = '';
    switch (name) {
        case 'edit_file':
        case 'write_file': {
            const n = (a.content ?? '').split('\n').length;
            summary = `Wrote ${n} line${n === 1 ? '' : 's'}`;
            break;
        }
        case 'create_file': {
            const n = (a.content ?? '').split('\n').length;
            summary = `Created file · ${n} line${n === 1 ? '' : 's'}`;
            break;
        }
        case 'patch_file':
            summary = lines[0] ?? 'Applied patch';
            break;
        case 'delete_file':
            summary = 'Deleted';
            break;
        case 'move_file':
            summary = `Moved → ${a.to ?? ''}`;
            break;
        case 'read_file': {
            const n = lines.length;
            summary = `Read ${n} line${n === 1 ? '' : 's'}`;
            break;
        }
        case 'list_files':
            summary = `Found ${lines.length} file${lines.length === 1 ? '' : 's'}`;
            break;
        case 'run_command':
        case 'run_tests':
        case 'git_commit':
        case 'git_status':
        case 'git_diff':
        case 'git_log': {
            const first = lines[0]?.slice(0, 80) ?? '';
            const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : '';
            summary = first + more;
            break;
        }
        case 'web_search':
            summary = `Found ${lines.length} result${lines.length === 1 ? '' : 's'}`;
            break;
        case 'web_extract':
            summary = `Extracted ${lines.length} line${lines.length === 1 ? '' : 's'}`;
            break;
        case 'search_codebase':
            summary = lines[0]?.slice(0, 80) ?? 'Done';
            break;
        default:
            summary = lines[0]?.slice(0, 80) ?? 'Done';
    }
    if (summary)
        write(gray(`  ${summary}`) + '\n');
}
export function toolMsg(_name, result) {
    const preview = result.length > 600 ? result.slice(0, 600) + '…' : result;
    const body = preview.trim()
        ? preview.split('\n').map(l => gray('    ' + l)).join('\n')
        : '';
    if (body)
        write(body + '\n');
}
export function systemMsg(text) {
    write(gray(`─ ${text}`) + '\n');
}
export function errorMsg(text) {
    write(gray(`error: ${text}`) + '\n');
}
export function divider() {
    const cols = process.stdout.columns ?? 80;
    write(`${gray('─'.repeat(cols))}\n`);
}
