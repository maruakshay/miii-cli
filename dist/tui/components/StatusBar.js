import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function StatusBar({ model, provider, status, tick }) {
    const isIdle = status === 'idle';
    const spinner = DOTS[tick % DOTS.length];
    const statusNode = status === 'idle' ? _jsxs(Text, { color: "green", children: ["\u25CF ", _jsx(Text, { color: "gray", children: "ready" })] })
        : status === 'thinking' ? _jsxs(Text, { color: "yellow", children: [spinner, " ", _jsx(Text, { color: "gray", children: "thinking" })] })
            : _jsxs(Text, { color: "yellow", children: [spinner, " ", _jsx(Text, { color: "gray", children: "tool" })] });
    return (_jsx(Box, { children: _jsxs(Box, { flexGrow: 1, paddingX: 1, paddingY: 0, justifyContent: "space-between", children: [_jsx(Text, { bold: true, color: "cyan", children: "MIII" }), _jsxs(Text, { color: "gray", dimColor: true, children: [provider, "/", model] }), statusNode] }) }));
}
export function Divider({ cols }) {
    return _jsx(Text, { color: "gray", dimColor: true, children: '─'.repeat(Math.max(cols, 10)) });
}
