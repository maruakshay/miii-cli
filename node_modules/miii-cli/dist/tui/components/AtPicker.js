import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Box, Text } from 'ink';
export function AtPicker({ files, query, idx }) {
    const filtered = useMemo(() => {
        if (!query)
            return files.slice(0, 8);
        return files.filter(f => f.rel.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
    }, [files, query]);
    if (!filtered.length) {
        return (_jsx(Box, { borderStyle: "round", borderColor: "gray", marginX: 1, paddingX: 1, children: _jsxs(Text, { color: "gray", children: ["no files match \"", query, "\""] }) }));
    }
    return (_jsx(Box, { flexDirection: "column", borderStyle: "round", borderColor: "gray", marginX: 1, children: filtered.map((f, i) => {
            const active = i === idx;
            const icon = f.type === 'dir' ? '/' : ' ';
            return (_jsxs(Box, { paddingX: 1, children: [_jsxs(Text, { color: active ? 'cyan' : 'white', bold: active, children: [active ? '▶' : ' ', icon] }), _jsxs(Text, { color: active ? 'cyan' : f.type === 'dir' ? 'blue' : 'white', children: [' ', f.rel] }), f.size !== undefined && (_jsxs(Text, { color: "gray", dimColor: true, children: ['  ', f.size > 1024 ? `${(f.size / 1024).toFixed(0)}k` : `${f.size}b`] }))] }, f.path));
        }) }));
}
//# sourceMappingURL=AtPicker.js.map