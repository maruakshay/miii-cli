import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { fmtSize } from '../../llm/ollama.js';
const BAR_WIDTH = 20;
function progressBar(pct) {
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}
export function ModelPicker({ models, current, loading, error, pull, onSelect, onPull, onClose }) {
    const [idx, setIdx] = useState(() => {
        const i = models.findIndex(m => m.name === current);
        return i >= 0 ? i : 0;
    });
    const [mode, setMode] = useState('list');
    const [pullInput, setPullInput] = useState('');
    const totalItems = models.length + 1; // +1 for "pull new" row
    useInput((input, key) => {
        if (key.escape) {
            if (mode === 'pull-input') {
                setMode('list');
                setPullInput('');
                return;
            }
            onClose();
            return;
        }
        if (mode === 'list') {
            if (key.upArrow) {
                setIdx(i => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow) {
                setIdx(i => Math.min(totalItems - 1, i + 1));
                return;
            }
            if (key.return) {
                if (idx < models.length) {
                    onSelect(models[idx].name);
                }
                else {
                    setMode('pull-input');
                }
                return;
            }
            return;
        }
        if (mode === 'pull-input') {
            if (key.return) {
                const name = pullInput.trim();
                if (name) {
                    setMode('pulling');
                    onPull(name);
                }
                return;
            }
            if (key.backspace || key.delete) {
                setPullInput(p => p.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setPullInput(p => p + input);
                return;
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: "cyan", paddingX: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: " models " }), loading && _jsx(Text, { color: "yellow", children: " loading..." }), error && _jsxs(Text, { color: "red", children: [" ", error] })] }), mode === 'list' && (_jsxs(_Fragment, { children: [models.map((m, i) => {
                        const active = i === idx;
                        const isCurrent = m.name === current;
                        const age = new Date(m.modified_at).toLocaleDateString();
                        return (_jsxs(Box, { children: [_jsxs(Text, { color: active ? 'cyan' : 'white', children: [active ? '▶ ' : '  ', m.name.padEnd(28)] }), _jsxs(Text, { color: "gray", children: [fmtSize(m.size).padEnd(8), age] }), isCurrent && _jsx(Text, { color: "green", bold: true, children: "  \u2713 active" })] }, m.name));
                    }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: idx === models.length ? 'cyan' : 'gray', children: [idx === models.length ? '▶ ' : '  ', "[pull new model...]"] }) })] })), mode === 'pull-input' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: "model name: " }), _jsxs(Text, { children: [pullInput, "\u2588"] })] }), _jsx(Text, { color: "gray", dimColor: true, children: "enter to pull, esc to cancel" })] })), mode === 'pulling' && pull && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: ["pulling ", _jsx(Text, { color: "cyan", children: pull.name })] }), _jsxs(Box, { children: [_jsxs(Text, { color: "yellow", children: [progressBar(pull.pct ?? 0), " "] }), _jsx(Text, { children: pull.pct !== undefined ? `${pull.pct}%` : '' })] }), _jsx(Text, { color: "gray", dimColor: true, children: pull.status })] })), _jsx(Box, { marginTop: 1, borderTop: true, borderStyle: "single", borderColor: "gray", children: _jsx(Text, { color: "gray", dimColor: true, children: "\u2191\u2193 navigate  enter select  esc close" }) })] }));
}
