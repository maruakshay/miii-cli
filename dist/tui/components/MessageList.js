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
function AssistantMsg({ msg }) {
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
function MsgItem({ msg }) {
    switch (msg.role) {
        case 'user': return _jsx(UserMsg, { msg: msg });
        case 'assistant': return _jsx(AssistantMsg, { msg: msg });
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
export function MessageList({ messages, rows, cols, scrollOffset, streaming }) {
    const availRows = Math.max(rows - 2, 4);
    const { visible, hiddenAbove, hiddenBelow } = useMemo(() => computeSlice(messages, availRows, scrollOffset, cols), [messages, availRows, scrollOffset, cols]);
    return (_jsxs(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", paddingX: 1, children: [_jsx(ScrollHint, { hiddenAbove: hiddenAbove, hiddenBelow: hiddenBelow }), visible.length === 0 && hiddenAbove === 0 && (_jsx(Box, { paddingTop: 1, children: _jsx(Text, { color: "gray", dimColor: true, children: "start typing below \u2014 @ for files, / for commands" }) })), visible.map(msg => _jsx(MsgItem, { msg: msg }, msg.id)), streaming && scrollOffset === 0 && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: "gray", dimColor: true, children: "\u258B" }) }))] }));
}
//# sourceMappingURL=MessageList.js.map