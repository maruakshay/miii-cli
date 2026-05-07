import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Box, Text } from 'ink';
export function CommandPalette({ skills, query, idx }) {
    const filtered = useMemo(() => {
        const q = query.toLowerCase();
        if (!q)
            return skills.slice(0, 8);
        return skills.filter(s => s.name.includes(q) ||
            `${s.ns}:${s.name}`.includes(q) ||
            s.description.toLowerCase().includes(q)).slice(0, 8);
    }, [skills, query]);
    if (!filtered.length) {
        return (_jsx(Box, { borderStyle: "round", borderColor: "gray", marginX: 1, paddingX: 1, children: _jsx(Text, { color: "gray", children: "no commands match" }) }));
    }
    return (_jsx(Box, { flexDirection: "column", borderStyle: "round", borderColor: "gray", marginX: 1, children: filtered.map((s, i) => {
            const active = i === idx;
            const name = s.ns === 'default' ? `/${s.name}` : `/${s.ns}:${s.name}`;
            return (_jsxs(Box, { paddingX: 1, children: [_jsxs(Text, { color: active ? 'cyan' : 'white', bold: active, children: [active ? '▶ ' : '  ', name.padEnd(26)] }), _jsx(Text, { color: "gray", dimColor: true, children: s.description })] }, `${s.ns}:${s.name}`));
        }) }));
}
//# sourceMappingURL=CommandPalette.js.map