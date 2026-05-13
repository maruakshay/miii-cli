import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { listFiles } from '../../files/ops.js';
import { CommandPalette } from './CommandPalette.js';
import { AtPicker } from './AtPicker.js';
const BUILTIN_COMMANDS = [
    { ns: 'builtin', name: 'new', description: 'start a fresh session (auto-named)' },
    { ns: 'builtin', name: 'models', description: 'switch or pull Ollama models' },
    { ns: 'builtin', name: 'clear', description: 'clear chat history for current session' },
    { ns: 'builtin', name: 'sessions', description: 'list all saved sessions' },
    { ns: 'builtin', name: 'session', description: 'switch session  /session <name>' },
    { ns: 'builtin', name: 'exit', description: 'exit miii' },
    { ns: 'builtin', name: 'model', description: 'switch model mid-session  /model <name>' },
    { ns: 'builtin', name: 'version', description: 'show current miii version' },
    { ns: 'builtin', name: 'tavily-key', description: 'set Tavily API key for web search  /tavily-key tvly-...' },
    { ns: 'builtin', name: 'skills', description: 'install/uninstall/list npm skills  /skills install <name>' },
    { ns: 'builtin', name: 'list', description: 'list all loaded skills' },
    { ns: 'builtin', name: 'plan', description: 'start planning mode  /plan [topic]' },
    { ns: 'builtin', name: 'refactor', description: 'multi-file AI refactor  /refactor <goal>' },
    { ns: 'git', name: 'status', description: 'show git working tree status' },
    { ns: 'git', name: 'diff', description: 'show unstaged diff' },
    { ns: 'git', name: 'diff --staged', description: 'show staged diff' },
    { ns: 'git', name: 'log', description: 'show recent commits' },
    { ns: 'git', name: 'review', description: 'review current changes with AI' },
    { ns: 'git', name: 'branch', description: 'list branches' },
    { ns: 'git', name: 'commit', description: 'stage all and commit  /git commit <msg>' },
];
const PLANNING_COMMANDS = [
    { ns: 'plan', name: 'next', description: 'suggest next concrete steps' },
    { ns: 'plan', name: 'breakdown', description: 'break current topic into subtasks' },
    { ns: 'plan', name: 'review', description: 'review and critique the plan so far' },
    { ns: 'plan', name: 'done', description: 'exit planning mode' },
];
const PASTE_MIN_CHARS = 120;
function wordStartBefore(line, col) {
    let i = col;
    while (i > 0 && line[i - 1] === ' ')
        i--;
    while (i > 0 && line[i - 1] !== ' ')
        i--;
    return i;
}
function wordEndAfter(line, col) {
    let i = col;
    while (i < line.length && line[i] === ' ')
        i++;
    while (i < line.length && line[i] !== ' ')
        i++;
    return i;
}
export function InputArea({ status, skills, cwd, planningMode, permissionRequest, onPermissionResponse, onSubmit, onAbort, history = [] }) {
    const [lines, setLines] = useState(['']);
    const [cursor, setCursor] = useState({ row: 0, col: 0 });
    const [overlay, setOverlay] = useState('none');
    const [overlayIdx, setOverlayIdx] = useState(0);
    const [pasteLines, setPasteLines] = useState(0);
    const pasteRef = useRef(null);
    const [historyIdx, setHistoryIdx] = useState(-1);
    const savedInputRef = useRef('');
    const [files, setFiles] = useState([]);
    const filesLoadedRef = useRef(false);
    const allCommands = useMemo(() => {
        const builtinNames = new Set(BUILTIN_COMMANDS.map(b => b.name));
        const userSkills = skills.filter(s => !builtinNames.has(s.name));
        const base = [...BUILTIN_COMMANDS, ...userSkills];
        return planningMode ? [...PLANNING_COMMANDS, ...base] : base;
    }, [skills, planningMode]);
    const isActive = status === 'idle';
    const fullInput = lines.join('\n');
    const commandQuery = useMemo(() => fullInput.startsWith('/') ? fullInput.slice(1) : '', [fullInput]);
    const atQuery = useMemo(() => {
        const line = lines[cursor.row] ?? '';
        const before = line.slice(0, cursor.col);
        const atIdx = before.lastIndexOf('@');
        if (atIdx === -1)
            return '';
        const after = before.slice(atIdx + 1);
        if (after.includes(' '))
            return '';
        return after;
    }, [lines, cursor]);
    const filteredCommands = useMemo(() => {
        const q = commandQuery.toLowerCase();
        if (!q)
            return allCommands.slice(0, 10);
        return allCommands.filter(s => s.name.includes(q) ||
            `${s.ns}:${s.name}`.includes(q) ||
            s.description.toLowerCase().includes(q)).slice(0, 10);
    }, [commandQuery, allCommands]);
    const filteredFiles = useMemo(() => {
        if (!atQuery)
            return [];
        if (!filesLoadedRef.current) {
            filesLoadedRef.current = true;
            setTimeout(() => { try {
                setFiles(listFiles(cwd, true));
            }
            catch {
                filesLoadedRef.current = false;
            } }, 0);
            return [];
        }
        return files.filter(f => f.rel.toLowerCase().includes(atQuery.toLowerCase())).slice(0, 8);
    }, [atQuery, files, cwd]);
    const overlayCount = overlay === 'command' ? filteredCommands.length : filteredFiles.length;
    function clearInput() {
        setLines(['']);
        setCursor({ row: 0, col: 0 });
        setOverlay('none');
        setOverlayIdx(0);
        pasteRef.current = null;
        setPasteLines(0);
        setHistoryIdx(-1);
        savedInputRef.current = '';
    }
    function appendChar(ch) {
        setLines(prev => {
            const next = [...prev];
            const r = cursor.row;
            next[r] = next[r].slice(0, cursor.col) + ch + next[r].slice(cursor.col);
            return next;
        });
        setCursor(c => ({ ...c, col: c.col + ch.length }));
    }
    function insertNewline() {
        const { row, col } = cursor;
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        setLines(prev => {
            const next = [...prev];
            next.splice(row, 1, before, after);
            return next;
        });
        setCursor({ row: row + 1, col: 0 });
    }
    function deleteChar() {
        const { row, col } = cursor;
        if (col > 0) {
            setLines(prev => {
                const next = [...prev];
                next[row] = next[row].slice(0, col - 1) + next[row].slice(col);
                return next;
            });
            setCursor(c => ({ ...c, col: c.col - 1 }));
        }
        else if (row > 0) {
            const prevLen = lines[row - 1].length;
            setLines(prev => {
                const next = [...prev];
                next.splice(row - 1, 2, next[row - 1] + next[row]);
                return next;
            });
            setCursor({ row: row - 1, col: prevLen });
        }
    }
    function recallHistory(idx) {
        const entry = history[history.length - 1 - idx];
        if (!entry)
            return;
        const recalled = entry.split('\n');
        setLines(recalled);
        setCursor({ row: 0, col: recalled[0].length });
        setHistoryIdx(idx);
    }
    function selectCommand(skill) {
        const name = (skill.ns === 'default' || skill.ns === 'builtin')
            ? `/${skill.name}`
            : skill.ns === 'git'
                ? `/git ${skill.name}`
                : `/${skill.ns}:${skill.name}`;
        clearInput();
        onSubmit(name);
    }
    function selectFile(file) {
        setLines(prev => {
            const next = [...prev];
            const r = cursor.row;
            const line = next[r];
            const before = line.slice(0, cursor.col);
            const atIdx = before.lastIndexOf('@');
            if (atIdx === -1)
                return prev;
            const newLine = line.slice(0, atIdx) + '@' + file.rel + ' ' + line.slice(cursor.col);
            next[r] = newLine;
            setCursor({ row: r, col: atIdx + 1 + file.rel.length + 1 });
            return next;
        });
        setOverlay('none');
        setOverlayIdx(0);
    }
    useInput((input, key) => {
        if (permissionRequest && onPermissionResponse) {
            if (input === 'y' || input === 'Y') {
                onPermissionResponse(true);
                return;
            }
            if (input === 'n' || input === 'N' || key.escape) {
                onPermissionResponse(false);
                return;
            }
            return;
        }
        if (key.escape) {
            if (overlay !== 'none') {
                setOverlay('none');
                setOverlayIdx(0);
                return;
            }
            if (status !== 'idle') {
                onAbort();
                return;
            }
            clearInput();
            return;
        }
        if (key.ctrl && input === 'c') {
            if (status !== 'idle') {
                onAbort();
            }
            else {
                process.exit(0);
            }
            return;
        }
        if (!isActive)
            return;
        // Overlay navigation
        if (overlay !== 'none') {
            if (key.upArrow) {
                setOverlayIdx(i => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow) {
                setOverlayIdx(i => Math.min(overlayCount - 1, i + 1));
                return;
            }
            if (key.return) {
                if (overlay === 'command') {
                    if (commandQuery.includes(' ')) {
                        const text = fullInput.trim();
                        if (text) {
                            clearInput();
                            onSubmit(text);
                        }
                    }
                    else if (filteredCommands[overlayIdx]) {
                        selectCommand(filteredCommands[overlayIdx]);
                    }
                }
                else if (overlay === 'at' && filteredFiles[overlayIdx]) {
                    selectFile(filteredFiles[overlayIdx]);
                }
                return;
            }
        }
        if (key.return) {
            const typed = fullInput.trim();
            const pasted = pasteRef.current;
            const text = pasted
                ? typed ? `${typed}\n${pasted}` : pasted
                : typed;
            if (text) {
                clearInput();
                onSubmit(text);
            }
            return;
        }
        // Ctrl+J — insert newline without submitting
        if (key.ctrl && input === 'j') {
            insertNewline();
            return;
        }
        if (key.backspace || key.delete) {
            if (pasteRef.current) {
                pasteRef.current = null;
                setPasteLines(0);
                return;
            }
            deleteChar();
            const r = cursor.row;
            const col = cursor.col;
            const prospectiveLine = col > 0
                ? lines[r].slice(0, col - 1) + lines[r].slice(col)
                : lines[r];
            const prospectiveLines = [...lines];
            prospectiveLines[r] = prospectiveLine;
            const prospective = prospectiveLines.join('\n');
            if (overlay === 'command' && !prospective.startsWith('/'))
                setOverlay('none');
            if (overlay === 'at') {
                const before = prospectiveLine.slice(0, Math.max(0, col - 1));
                if (before.lastIndexOf('@') === -1)
                    setOverlay('none');
            }
            return;
        }
        // Ctrl chords
        if (key.ctrl) {
            const { row, col } = cursor;
            const line = lines[row] ?? '';
            if (input === 'a') {
                setCursor(c => ({ ...c, col: 0 }));
                return;
            }
            if (input === 'e') {
                setCursor(c => ({ ...c, col: line.length }));
                return;
            }
            if (input === 'w') {
                if (col === 0)
                    return;
                const newCol = wordStartBefore(line, col);
                setLines(prev => {
                    const next = [...prev];
                    next[row] = line.slice(0, newCol) + line.slice(col);
                    return next;
                });
                setCursor(c => ({ ...c, col: newCol }));
                return;
            }
            if (input === 'k') {
                setLines(prev => {
                    const next = [...prev];
                    next[row] = line.slice(0, col);
                    return next;
                });
                return;
            }
            if (input === 'u') {
                setLines(prev => {
                    const next = [...prev];
                    next[row] = '';
                    return next;
                });
                setCursor(c => ({ ...c, col: 0 }));
                return;
            }
            if (key.leftArrow) {
                setCursor(c => ({ ...c, col: wordStartBefore(line, col) }));
                return;
            }
            if (key.rightArrow) {
                setCursor(c => ({ ...c, col: wordEndAfter(line, col) }));
                return;
            }
            return;
        }
        // Arrow keys
        if (key.upArrow && overlay === 'none') {
            if (cursor.row > 0) {
                setCursor(c => ({ row: c.row - 1, col: Math.min(c.col, lines[c.row - 1]?.length ?? 0) }));
                return;
            }
            // history recall at top row
            if (history.length > 0) {
                const nextIdx = historyIdx + 1;
                if (nextIdx < history.length) {
                    if (historyIdx === -1)
                        savedInputRef.current = fullInput;
                    recallHistory(nextIdx);
                }
            }
            return;
        }
        if (key.downArrow && overlay === 'none') {
            if (cursor.row < lines.length - 1) {
                setCursor(c => ({ row: c.row + 1, col: Math.min(c.col, lines[c.row + 1]?.length ?? 0) }));
                return;
            }
            // history forward at bottom row
            if (historyIdx > 0) {
                recallHistory(historyIdx - 1);
            }
            else if (historyIdx === 0) {
                const saved = savedInputRef.current;
                const restored = saved ? saved.split('\n') : [''];
                setLines(restored);
                setCursor({ row: 0, col: restored[0].length });
                setHistoryIdx(-1);
                savedInputRef.current = '';
            }
            return;
        }
        if (key.leftArrow) {
            setCursor(c => ({ ...c, col: Math.max(0, c.col - 1) }));
            return;
        }
        if (key.rightArrow) {
            setCursor(c => ({ ...c, col: Math.min(lines[c.row]?.length ?? 0, c.col + 1) }));
            return;
        }
        if (input && !key.meta) {
            // Detect paste
            const hasNewline = input.includes('\n');
            const lineCount = hasNewline ? input.split('\n').length : 1;
            if (input.length > 1 && (hasNewline || input.length >= PASTE_MIN_CHARS)) {
                pasteRef.current = input;
                setPasteLines(lineCount);
                return;
            }
            // Exit history mode on any edit
            if (historyIdx !== -1)
                setHistoryIdx(-1);
            const r = cursor.row;
            const col = cursor.col;
            const prospectiveLine = lines[r].slice(0, col) + input + lines[r].slice(col);
            const prospectiveLines = [...lines];
            prospectiveLines[r] = prospectiveLine;
            const prospective = prospectiveLines.join('\n');
            appendChar(input);
            if (prospective.startsWith('/')) {
                if (prospective.slice(1).includes(' ')) {
                    setOverlay('none');
                }
                else {
                    setOverlay('command');
                    setOverlayIdx(0);
                }
            }
            else if (input === '@' || (overlay === 'at' && atQuery !== undefined)) {
                setOverlay('at');
                setOverlayIdx(0);
            }
            else if (overlay === 'command') {
                setOverlay('none');
            }
        }
    });
    const { stdout } = useStdout();
    const cols = stdout.columns ?? 80;
    const isProcessing = status !== 'idle';
    const promptColor = permissionRequest ? 'yellow' : isProcessing ? 'yellow' : 'green';
    const inHistory = historyIdx !== -1;
    const hint = permissionRequest
        ? 'y  approve   n  deny'
        : isProcessing
            ? 'esc  interrupt'
            : pasteLines > 0
                ? 'backspace  remove paste   enter  send'
                : overlay !== 'none'
                    ? '↑↓  navigate   enter  select   esc  close'
                    : inHistory
                        ? `history ${historyIdx + 1}/${history.length}   ↑↓  navigate   esc  clear`
                        : planningMode
                            ? 'planning mode   /plan:done  exit'
                            : '?  for shortcuts';
    const pastePreview = pasteRef.current
        ? pasteRef.current.split('\n')[0].slice(0, cols - 6)
        : '';
    return (_jsxs(Box, { flexDirection: "column", children: [overlay === 'command' && (_jsx(CommandPalette, { skills: allCommands, query: commandQuery, idx: overlayIdx })), overlay === 'at' && (_jsx(AtPicker, { files: filteredFiles, query: atQuery, idx: overlayIdx })), _jsx(Text, { color: "gray", dimColor: true, children: '─'.repeat(Math.max(cols, 10)) }), _jsxs(Box, { paddingX: 1, children: [_jsx(Text, { color: promptColor, bold: true, children: '> ' }), _jsx(Box, { flexDirection: "column", flexGrow: 1, children: permissionRequest ? (_jsxs(Box, { gap: 2, children: [_jsx(Text, { color: "green", bold: true, children: "y  yes" }), _jsx(Text, { color: "red", bold: true, children: "n  no" })] })) : pasteLines > 0 ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "cyan", children: "\u2398" }), _jsxs(Text, { color: "cyan", children: ["pasted ", pasteLines, " line", pasteLines !== 1 ? 's' : ''] }), (lines.length > 1 || lines[0]) && (_jsx(Text, { color: "gray", dimColor: true, children: "+ typed text" }))] }), pastePreview && (_jsxs(Text, { color: "gray", dimColor: true, children: ["  ", pastePreview, pasteRef.current.split('\n')[0].length > cols - 6 ? '…' : ''] }))] })) : lines.length === 1 && !lines[0] ? (_jsx(Text, { children: isActive ? '█' : ' ' })) : (lines.map((line, i) => (_jsx(Text, { wrap: "wrap", children: i === cursor.row
                                ? renderLineWithCursor(line, cursor.col, isActive)
                                : line }, i)))) })] }), _jsx(Text, { color: "gray", dimColor: true, children: '─'.repeat(Math.max(cols, 10)) }), _jsxs(Text, { color: "gray", dimColor: true, children: ["  ", hint] })] }));
}
function renderLineWithCursor(line, col, showCursor) {
    return line.slice(0, col) + (showCursor ? '█' : '') + line.slice(col);
}
