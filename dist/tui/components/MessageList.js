import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Box, Text } from 'ink';
// ─── height estimation ───────────────────────────────────────────────────────
function msgHeight(msg, cols) {
    const usable = Math.max(cols - 8, 20);
    if (msg.role === 'system')
        return 2;
    if (msg.role === 'tool')
        return 3;
    let h = 2; // label + blank
    for (const line of msg.content.split('\n')) {
        h += Math.max(1, Math.ceil((line.length || 1) / usable));
    }
    return Math.min(h, 40);
}
function computeSlice(messages, availRows, offset, cols) {
    const clampedOffset = Math.max(0, Math.min(offset, Math.max(0, messages.length - 1)));
    const endIdx = messages.length - clampedOffset;
    let startIdx = endIdx;
    let usedRows = 0;
    while (startIdx > 0) {
        const h = msgHeight(messages[startIdx - 1], cols);
        if (usedRows + h > availRows)
            break;
        startIdx--;
        usedRows += h;
    }
    return {
        visible: messages.slice(startIdx, endIdx),
        hiddenAbove: startIdx,
        hiddenBelow: clampedOffset,
    };
}
function parseSegments(content) {
    const segs = [];
    let inCode = false;
    for (const line of content.split('\n')) {
        if (line.startsWith('```')) {
            segs.push({ text: line, code: false, fence: true });
            inCode = !inCode;
        }
        else {
            segs.push({ text: line, code: inCode, fence: false });
        }
    }
    return segs;
}
function ContentBlock({ content }) {
    const segs = useMemo(() => parseSegments(content), [content]);
    return (_jsx(Box, { flexDirection: "column", paddingLeft: 2, children: segs.map((seg, i) => seg.fence ? (_jsx(Text, { color: "gray", dimColor: true, children: seg.text }, i)) : seg.code ? (_jsx(Text, { color: "yellow", children: seg.text || ' ' }, i)) : (_jsx(Text, { wrap: "wrap", children: seg.text || ' ' }, i))) }));
}
// ─── message renderers ───────────────────────────────────────────────────────
function UserMsg({ msg }) {
    const parts = msg.content.split(/(@[\w./\-]+)/g);
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { bold: true, color: "blue", children: "You" }), _jsx(Box, { paddingLeft: 2, children: _jsx(Text, { wrap: "wrap", children: parts.map((p, i) => p.startsWith('@')
                        ? _jsx(Text, { color: "cyan", children: p }, i)
                        : _jsx(Text, { children: p }, i)) }) })] }));
}
const THINKING_PHRASES = [
    'oh wow, a question. let me pretend to care…',
    'consulting the void…',
    'making something up, just a sec…',
    'definitely not hallucinating right now…',
    'running 47 mental tabs…',
    'staring into the abyss (it blinked)…',
    'calculating your fate, no pressure…',
    'doing the thinking you pay me for…',
    'processing your questionable life choices…',
    'summoning coherent thoughts, rarely works…',
    'asking my imaginary friend for help…',
    'pretending this is a hard problem…',
    'yes, yes, very interesting. anyway…',
    'simulating intelligence… please wait…',
    'having a brief existential crisis…',
    'cross-referencing vibes…',
    'totally not making this up…',
    'the answer is 42. now finding the question…',
    'channelling the spirit of stack overflow…',
    'trying not to confidently be wrong…',
    'applying artificial to the intelligence…',
    'checking if this is even my problem to solve…',
];
const SPARKLE = ['✦', '✧', '✶', '✷', '✸', '✹'];
function AssistantMsg({ msg, thinkingTick }) {
    if (!msg.content && thinkingTick !== undefined) {
        const phrase = THINKING_PHRASES[Math.floor(thinkingTick / 62) % THINKING_PHRASES.length];
        const icon = SPARKLE[thinkingTick % SPARKLE.length];
        return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { bold: true, color: "green", children: "miii" }), _jsxs(Box, { paddingLeft: 2, children: [_jsxs(Text, { color: "yellow", children: [icon, " "] }), _jsx(Text, { color: "gray", dimColor: true, italic: true, children: phrase })] })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { bold: true, color: "green", children: "miii" }), _jsx(ContentBlock, { content: msg.content })] }));
}
function ToolMsg({ msg }) {
    const lines = msg.content.split('\n');
    const name = (lines[0] ?? '').replace(/^\[/, '').replace(/\]$/, '');
    const body = lines.slice(1).join('\n').trim();
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, paddingLeft: 2, children: [_jsxs(Text, { color: "green", children: ["\u2713 ", _jsx(Text, { color: "cyan", children: name })] }), body && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: "gray", dimColor: true, wrap: "wrap", children: body.length > 300 ? body.slice(0, 300) + '…' : body }) }))] }));
}
function SystemMsg({ msg }) {
    return (_jsx(Box, { marginBottom: 1, paddingLeft: 1, children: _jsxs(Text, { color: "gray", dimColor: true, children: ["\u2500 ", msg.content] }) }));
}
function MsgItem({ msg, thinkingTick }) {
    switch (msg.role) {
        case 'user': return _jsx(UserMsg, { msg: msg });
        case 'assistant': return _jsx(AssistantMsg, { msg: msg, thinkingTick: thinkingTick });
        case 'tool': return _jsx(ToolMsg, { msg: msg });
        case 'system': return _jsx(SystemMsg, { msg: msg });
        default: return null;
    }
}
// ─── scroll hint bar ─────────────────────────────────────────────────────────
function ScrollHint({ hiddenAbove, hiddenBelow }) {
    if (hiddenAbove === 0 && hiddenBelow === 0)
        return null;
    const parts = [];
    if (hiddenAbove > 0)
        parts.push(`↑ ${hiddenAbove} above`);
    if (hiddenBelow > 0)
        parts.push(`↓ ${hiddenBelow} below`);
    return (_jsx(Box, { justifyContent: "center", children: _jsxs(Text, { color: "gray", dimColor: true, children: [parts.join('  '), "  \u00B7 PgUp/PgDn"] }) }));
}
// ─── main export ─────────────────────────────────────────────────────────────
export function MessageList({ messages, rows, cols, scrollOffset, streaming, thinkingTick }) {
    const availRows = Math.max(rows - 2, 4);
    const { visible, hiddenAbove, hiddenBelow } = useMemo(() => computeSlice(messages, availRows, scrollOffset, cols), [messages, availRows, scrollOffset, cols]);
    return (_jsxs(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", paddingX: 1, children: [_jsx(ScrollHint, { hiddenAbove: hiddenAbove, hiddenBelow: hiddenBelow }), visible.length === 0 && hiddenAbove === 0 && (_jsx(Box, { paddingTop: 1, children: _jsx(Text, { color: "gray", dimColor: true, children: "start typing below \u2014 @ for files, / for commands" }) })), visible.map(msg => _jsx(MsgItem, { msg: msg, thinkingTick: thinkingTick }, msg.id)), streaming && scrollOffset === 0 && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: "gray", dimColor: true, children: "\u258B" }) }))] }));
}
