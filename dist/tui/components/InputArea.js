import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { listFiles } from '../../files/ops.js';
import { CommandPalette } from './CommandPalette.js';
import { AtPicker } from './AtPicker.js';
const BUILTIN_COMMANDS = [
    // ── Session ──────────────────────────────────────────────────────────────
    { ns: 'builtin', name: 'new', description: 'start a fresh session with a new auto-named history' },
    { ns: 'builtin', name: 'compact', description: 'summarise conversation history now using the LLM — frees context before miii asks' },
    { ns: 'builtin', name: 'clear', description: 'wipe chat history for the current session' },
    { ns: 'builtin', name: 'sessions', description: 'list all saved sessions with message counts' },
    { ns: 'builtin', name: 'session', description: 'switch to a saved session — /session <name>' },
    { ns: 'builtin', name: 'exit', description: 'exit miii (saves session first)' },
    // ── Config ───────────────────────────────────────────────────────────────
    { ns: 'builtin', name: 'config', description: 'open config picker — change provider, model, API key, base URL, Tavily key with arrow-key navigation' },
    { ns: 'builtin', name: 'model', description: 'quickly switch model for this session — /model <name>' },
    { ns: 'builtin', name: 'version', description: 'show the current miii version' },
    // ── Skills ───────────────────────────────────────────────────────────────
    { ns: 'builtin', name: 'skills', description: 'install, uninstall, or list npm skill packages' },
    { ns: 'builtin', name: 'list', description: 'list all loaded skills and their descriptions' },
    // ── AI modes ─────────────────────────────────────────────────────────────
    { ns: 'builtin', name: 'plan', description: 'enter planning mode — AI helps think through a goal step-by-step' },
    { ns: 'builtin', name: 'refactor', description: 'multi-file AI refactor — plans, reads, then edits — /refactor <goal>' },
    { ns: 'builtin', name: 'think', description: 'deep research before answering — reads files + optional web — /think <query>' },
    { ns: 'builtin', name: 'watch', description: 'watch for file changes, run tests, auto-fix failures — /watch stop to cancel' },
    // ── Git ───────────────────────────────────────────────────────────────────
    { ns: 'git', name: 'status', description: 'show git working tree status (modified, staged, untracked)' },
    { ns: 'git', name: 'diff', description: 'show unstaged changes as a diff' },
    { ns: 'git', name: 'diff --staged', description: 'show staged changes ready to commit' },
    { ns: 'git', name: 'log', description: 'show recent commit history (last 10)' },
    { ns: 'git', name: 'review', description: 'AI code review of current uncommitted changes' },
    { ns: 'git', name: 'branch', description: 'list local branches' },
    { ns: 'git', name: 'commit', description: 'stage everything and commit — /git commit <message>' },
];
const PLANNING_COMMANDS = [
    { ns: 'plan', name: 'next', description: 'suggest the next concrete steps to take' },
    { ns: 'plan', name: 'breakdown', description: 'break the current goal into specific subtasks' },
    { ns: 'plan', name: 'review', description: 'critique the plan so far — find gaps and risks' },
    { ns: 'plan', name: 'done', description: 'exit planning mode and return to normal chat' },
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
export function InputArea({ status, skills, cwd, planningMode, permissionRequest, onPermissionResponse, designTeach, onDesignTeachAnswer, onSubmit, onAbort, history = [], watchActive = false }) {
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
        const r = cursor.row;
        const line = lines[r];
        const before = line.slice(0, cursor.col);
        const atIdx = before.lastIndexOf('@');
        if (atIdx === -1)
            return;
        const newLine = line.slice(0, atIdx) + '@' + file.rel + ' ' + line.slice(cursor.col);
        setLines(prev => {
            const next = [...prev];
            next[r] = newLine;
            return next;
        });
        setCursor({ row: r, col: atIdx + 1 + file.rel.length + 1 });
        setOverlay('none');
        setOverlayIdx(0);
    }
    useInput((input, key) => {
        if (permissionRequest && onPermissionResponse) {
            if (input === 'y' || input === 'Y') {
                onPermissionResponse('yes');
                return;
            }
            if (input === 'a' || input === 'A') {
                onPermissionResponse('session');
                return;
            }
            if (input === 'n' || input === 'N' || key.escape) {
                onPermissionResponse('no');
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
            if (designTeach && onDesignTeachAnswer) {
                const answer = fullInput.trim();
                clearInput();
                onDesignTeachAnswer(answer || '(skipped)');
                return;
            }
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
                    if (input === '@' || overlay === 'at') {
                        setOverlay('at');
                        setOverlayIdx(0);
                    }
                    else {
                        setOverlay('none');
                    }
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
    const availWidth = Math.max(20, cols - 4); // paddingX(2) + "> "(2)
    const isProcessing = status !== 'idle';
    const promptColor = permissionRequest ? 'yellow' : designTeach ? 'cyan' : isProcessing ? 'yellow' : 'green';
    const inHistory = historyIdx !== -1;
    const hint = designTeach
        ? 'enter  submit answer   esc  skip'
        : permissionRequest
            ? 'y  approve once   a  approve for session   n  deny'
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
                                : watchActive
                                    ? 'watch active   /watch stop to cancel'
                                    : '?  for shortcuts';
    const pastePreview = pasteRef.current
        ? pasteRef.current.split('\n')[0].slice(0, cols - 6)
        : '';
    return (_jsxs(Box, { flexDirection: "column", children: [overlay === 'command' && (_jsx(CommandPalette, { skills: allCommands, query: commandQuery, idx: overlayIdx })), overlay === 'at' && (_jsx(AtPicker, { files: filteredFiles, query: atQuery, idx: overlayIdx })), _jsx(Text, { color: "gray", dimColor: true, children: '─'.repeat(Math.max(cols, 10)) }), _jsxs(Box, { paddingX: 1, children: [_jsx(Text, { color: promptColor, bold: true, children: '> ' }), _jsx(Box, { flexDirection: "column", flexGrow: 1, children: permissionRequest ? (_jsxs(Box, { gap: 3, children: [_jsx(Text, { color: "green", bold: true, children: "y  once" }), _jsx(Text, { color: "cyan", bold: true, children: "a  session" }), _jsx(Text, { color: "red", bold: true, children: "n  deny" })] })) : pasteLines > 0 ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "cyan", children: "\u2398" }), _jsxs(Text, { color: "cyan", children: ["pasted ", pasteLines, " line", pasteLines !== 1 ? 's' : ''] }), (lines.length > 1 || lines[0]) && (_jsx(Text, { color: "gray", dimColor: true, children: "+ typed text" }))] }), pastePreview && (_jsxs(Text, { color: "gray", dimColor: true, children: ["  ", pastePreview, pasteRef.current.split('\n')[0].length > cols - 6 ? '…' : ''] }))] })) : lines.length === 1 && !lines[0] ? (watchActive && isActive
                            ? _jsxs(Text, { children: [_jsx(Text, { color: "cyan", dimColor: true, children: "watching\u2026 " }), _jsx(Text, { children: "\u2588" })] })
                            : _jsx(Text, { children: isActive ? '█' : ' ' })) : (lines.map((line, i) => (_jsx(Text, { children: i === cursor.row
                                ? viewportLine(line, cursor.col, availWidth, isActive)
                                : line.length > availWidth ? '…' + line.slice(line.length - availWidth + 1) : line }, i)))) })] }), _jsx(Text, { color: "gray", dimColor: true, children: '─'.repeat(Math.max(cols, 10)) }), _jsxs(Text, { color: "gray", dimColor: true, children: ["  ", hint] })] }));
}
function renderLineWithCursor(line, col, showCursor) {
    return line.slice(0, col) + (showCursor ? '█' : '') + line.slice(col);
}
function viewportLine(line, col, width, active) {
    // If line fits, render normally
    if (line.length < width)
        return renderLineWithCursor(line, col, active);
    // Slide window so cursor stays in view, roughly centered
    let start = Math.max(0, col - Math.floor(width / 2));
    if (start + width > line.length + 1) {
        start = Math.max(0, line.length + 1 - width);
    }
    const hasLeft = start > 0;
    const sliceW = width - (hasLeft ? 1 : 0) - 1; // -1 for right indicator space
    const slice = line.slice(start, start + sliceW);
    const hasRight = start + sliceW < line.length;
    const adjCol = col - start;
    return (hasLeft ? '…' : '') +
        renderLineWithCursor(slice, Math.max(0, Math.min(adjCol, slice.length)), active) +
        (hasRight ? '…' : '');
}
