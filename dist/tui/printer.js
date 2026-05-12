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
const purple = (s) => col(95, s);
function indent(text, pad = '  ') {
    return text.split('\n').map(l => pad + l).join('\n');
}
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
function toolArgSummary(args) {
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
    const artLines = [
        '    ●       ●    ',
        '   ╱ ╲     ╱ ╲   ',
        '  ╱   ╲   ╱   ╲  ',
        ' ╱     ╲ ╱     ╲ ',
        '●       ●       ●',
        ' m i i i - c l i',
    ];
    const artPad = ' '.repeat(Math.max(0, Math.floor((cols - 17) / 2)));
    process.stdout.write('\n' + artLines.map(l => artPad + purple(l)).join('\n') + '\n\n');
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
    const username = process.env.USER ?? 'there';
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
        `  ${bold(cyan('Welcome back ' + username + '!'))}`,
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
        `  Use ${cyan('/models')} to switch or pull models`,
        '',
        `  ${bold(yellow("What's new"))}`,
        `  v0.2.6: ASCII logo on startup`,
        `  v0.2.5: Built-in skills & commands`,
        `  v0.2.4: Enhanced tool call handling`,
        `  ${dim(gray('/release-notes for more'))}`,
        '',
    ];
    const maxLen = Math.max(leftLines.length, rightLines.length);
    const pl = [...leftLines, ...Array(Math.max(0, maxLen - leftLines.length)).fill('')];
    const pr = [...rightLines, ...Array(Math.max(0, maxLen - rightLines.length)).fill('')];
    const contentRows = pl.map((l, i) => row(l, pr[i]));
    const upgradeCmd = linked ? 'cd <miii-dir> && npm run build' : 'npm install -g miii-cli';
    const separator = gray('│') + bold(yellow(' ⬆ update available: v' + updateAvailable + ' — run: ' + upgradeCmd)).padEnd(innerW - 1) + gray('│');
    const updateRow = updateAvailable
        ? [gray('├' + '─'.repeat(innerW) + '┤'), separator, gray('├' + '─'.repeat(innerW) + '┤')]
        : [];
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
    console.log(`\n${bold(blue('You'))}\n${indent(atHighlighted)}`);
}
export function assistantMsg(text) {
    console.log(`\n${bold(green('miii'))}\n${formatContent(text)}`);
}
export function toolCallStart(name, args) {
    const summary = toolArgSummary(args);
    process.stdout.write(`  ${gray('⎿')} ${cyan(name)}${summary ? gray('(' + summary + ')') : ''}\n`);
}
export function toolMsg(name, result) {
    const preview = result.length > 250 ? result.slice(0, 250) + '…' : result;
    const body = preview.trim()
        ? preview.split('\n').map(l => gray('    ' + l)).join('\n')
        : '';
    if (body)
        console.log(body);
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
