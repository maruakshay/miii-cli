import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useMemo, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
import { ConfigPicker } from './components/ConfigPicker.js';
import { Divider } from './components/StatusBar.js';
import { tools } from '../tools/index.js';
import { toolArgSummary, formatElapsed } from './printer.js';
import { MacroQueue } from '../tasks/queue.js';
import { TaskExecutor } from '../tasks/executor.js';
import { THINKING_PHRASES, SPARKLE } from './thinking.js';
import { useSession } from './hooks/useSession.js';
import { useModelPicker } from './hooks/useModelPicker.js';
import { useRunLoop } from './hooks/useRunLoop.js';
import { useRefactor } from './hooks/useRefactor.js';
import { useGit } from './hooks/useGit.js';
import { useSubmit } from './hooks/useSubmit.js';
import { useWatch } from './hooks/useWatch.js';
import { runDeepThink } from './deepThink.js';
import { setInkInstance } from './printer.js';
import { createSearchCodebaseTool } from '../index/tool.js';
import { saveConfig } from '../config.js';
import { getTavilyKey, saveTavilyKey } from '../tavily/client.js';
import { warmup } from '../llm/stream.js';
const MAX_DIFF_LINES = 40;
const DIFF_CTX = 2;
function lineDiff(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const m = a.length, n = b.length;
    if (m * n > 10000) {
        return [...a.map(line => ({ type: 'del', line })), ...b.map(line => ({ type: 'add', line }))];
    }
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
        for (let j = n - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const result = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && a[i] === b[j]) {
            result.push({ type: 'eq', line: a[i++] });
            j++;
        }
        else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
            result.push({ type: 'add', line: b[j++] });
        }
        else {
            result.push({ type: 'del', line: a[i++] });
        }
    }
    return result;
}
function diffHunks(diff) {
    const changedIdxs = diff.reduce((acc, d, i) => { if (d.type !== 'eq')
        acc.push(i); return acc; }, []);
    if (!changedIdxs.length)
        return [];
    const inHunk = new Set();
    for (const ci of changedIdxs)
        for (let k = Math.max(0, ci - DIFF_CTX); k <= Math.min(diff.length - 1, ci + DIFF_CTX); k++)
            inHunk.add(k);
    return diff.filter((_, i) => inHunk.has(i));
}
function DiffPreview({ toolName, args }) {
    if (toolName === 'update_file' && (args.old != null || args.new != null)) {
        const path = String(args.path ?? '');
        const diff = diffHunks(lineDiff(String(args.old ?? ''), String(args.new ?? '')));
        const visible = diff.slice(0, MAX_DIFF_LINES);
        const hidden = diff.length - visible.length;
        return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [_jsxs(Text, { color: "gray", dimColor: true, children: ["  ", path] }), visible.map((d, i) => (_jsxs(Text, { color: d.type === 'del' ? 'red' : d.type === 'add' ? 'green' : 'gray', dimColor: d.type === 'eq', children: [d.type === 'del' ? '- ' : d.type === 'add' ? '+ ' : '  ', d.line.slice(0, 76)] }, i))), hidden > 0 && _jsxs(Text, { color: "gray", dimColor: true, children: ["  \u2026", hidden, " more line", hidden === 1 ? '' : 's'] })] }));
    }
    if ((toolName === 'edit_file' || toolName === 'create_file') && args.content) {
        const path = String(args.path ?? '');
        const lines = String(args.content).split('\n');
        const visible = lines.slice(0, MAX_DIFF_LINES);
        const hidden = lines.length - visible.length;
        return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [_jsxs(Text, { color: "gray", dimColor: true, children: ["  ", path] }), visible.map((line, i) => (_jsxs(Text, { color: "green", children: ["+ ", line.slice(0, 76)] }, i))), hidden > 0 && _jsxs(Text, { color: "gray", dimColor: true, children: ["  \u2026", hidden, " more line", hidden === 1 ? '' : 's'] })] }));
    }
    return null;
}
export function InputBar({ config: initialConfig, skills, cwd, session, version, mcpTools = [] }) {
    const [config, setConfig] = useState(initialConfig);
    const { stdout, write: stdoutWrite } = useStdout();
    const cols = stdout.columns ?? 80;
    useEffect(() => {
        setInkInstance(stdoutWrite);
        warmup(initialConfig.provider, initialConfig.baseUrl, initialConfig.model);
    }, []);
    const phraseSeq = useMemo(() => Array.from({ length: 100 }, () => Math.floor(Math.random() * THINKING_PHRASES.length)), []);
    const [planningMode, setPlanningMode] = useState(false);
    const [configOpen, setConfigOpen] = useState(false);
    const [tavilyKey, setTavilyKey] = useState(() => getTavilyKey());
    const macroQueueRef = useRef(new MacroQueue());
    const executorRef = useRef(new TaskExecutor(tools));
    const lastGitStatusRef = useRef('');
    const abortRef = useRef(null);
    const { projectDir, setSessionName, sessionNameRef, historyRef, saveTimerRef, systemPromptRef, pushHistory, buildContext, renameFromMessage, updateMemory, } = useSession(session, cwd, config, mcpTools);
    const { currentModel, setCurrentModel, currentModelRef, pickerOpen, setPickerOpen, pickerModels, pickerLoading, pickerError, pullState, handleModelSelect, handleModelPull, } = useModelPicker(config);
    const deepThinkTool = useMemo(() => ({
        name: 'deep_think',
        description: 'Research tool: gather info from files and web before answering.',
        params: '{"query": "string", "needs_web": "boolean (optional)"}',
        execute: async ({ query }) => {
            const result = await runDeepThink(String(query), config, currentModelRef.current, abortRef.current?.signal);
            return `Research complete (${result.toolCalls} tool calls, ${result.webCalls} web):\n\n${result.findings}`;
        },
    }), [config]);
    const searchTool = useMemo(() => createSearchCodebaseTool(config, cwd), [config, cwd]);
    const allTools = useMemo(() => [...tools, deepThinkTool, searchTool, ...mcpTools], [deepThinkTool, searchTool, mcpTools]);
    const { status, setStatus, tick, currentTool, setCurrentTool, taskLabel, setTaskLabel, thinkingStartRef, runLoop, handleAbort, permissionRequest, resolvePermission, compactRequest, resolveCompact, } = useRunLoop(config, currentModelRef, pushHistory, allTools, abortRef);
    const { runRefactor } = useRefactor({
        config, currentModelRef, systemPromptRef, abortRef,
        macroQueueRef, executorRef,
        setStatus, setTaskLabel, setCurrentTool, pushHistory,
    });
    const { handleGit } = useGit({ pushHistory, buildContext, runLoop });
    const { watchActive, startWatch, stopWatch } = useWatch(cwd, { runLoop, buildContext, pushHistory });
    const { handleSubmit } = useSubmit({
        config, skills, cwd, projectDir, version, currentModelRef, setCurrentModel,
        historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
        setPlanningMode, runLoop, buildContext, pushHistory,
        setSessionName, renameFromMessage,
        setStatus, setTaskLabel, setCurrentTool,
        runRefactor, handleGit, lastGitStatusRef, mcpTools, setConfig,
        setConfigOpen, updateMemory,
        startWatch, stopWatch, watchActive,
    });
    const skillList = skills.list();
    return (_jsxs(Box, { flexDirection: "column", children: [configOpen ? (_jsxs(_Fragment, { children: [_jsx(ConfigPicker, { config: config, currentModel: currentModel, tavilyKey: tavilyKey, onUpdate: ({ model, ...configPatch }) => {
                            if (model)
                                setCurrentModel(model);
                            if (Object.keys(configPatch).length) {
                                setConfig(c => ({ ...c, ...configPatch }));
                                saveConfig(configPatch);
                            }
                        }, onTavilyKey: (key) => { saveTavilyKey(key); setTavilyKey(key); }, onClose: () => { setConfigOpen(false); } }), _jsx(Divider, { cols: cols })] })) : pickerOpen ? (_jsxs(_Fragment, { children: [_jsx(ModelPicker, { models: pickerModels, current: currentModel, loading: pickerLoading, error: pickerError, pull: pullState, onSelect: handleModelSelect, onPull: handleModelPull, onClose: () => { setPickerOpen(false); } }), _jsx(Divider, { cols: cols })] })) : compactRequest ? (_jsxs(Box, { paddingX: 1, flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0" }), _jsx(Text, { color: "white", bold: true, children: "context is large" }), _jsxs(Text, { color: "gray", children: ["(~", compactRequest.messageCount, "k chars)"] })] }), _jsx(Text, { color: "gray", dimColor: true, children: "compact to keep responses fast, or keep full history" })] })) : permissionRequest ? (_jsxs(Box, { paddingX: 1, flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0" }), _jsx(Text, { color: "white", bold: true, children: permissionRequest.toolName }), _jsx(Text, { color: "gray", children: toolArgSummary(permissionRequest.args) })] }), _jsx(DiffPreview, { toolName: permissionRequest.toolName, args: permissionRequest.args })] })) : (status === 'thinking' || status === 'tool') ? (_jsx(Box, { paddingX: 1, gap: 1, children: status === 'thinking'
                    ? _jsxs(_Fragment, { children: [_jsx(Text, { color: "yellow", children: SPARKLE[tick % SPARKLE.length] }), _jsx(Text, { color: Math.floor(tick / 4) % 6 >= 2 && Math.floor(tick / 4) % 6 <= 4 ? 'white' : 'gray', italic: true, children: THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]] }), _jsx(Text, { color: "gray", dimColor: true, children: formatElapsed(Date.now() - thinkingStartRef.current) }), taskLabel && _jsx(Text, { color: "cyan", dimColor: true, children: taskLabel })] })
                    : _jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", dimColor: true, children: ["\u2699 running ", currentTool ?? 'tool', "\u2026"] }), _jsx(Text, { color: "gray", dimColor: true, children: formatElapsed(Date.now() - thinkingStartRef.current) }), taskLabel && _jsx(Text, { color: "cyan", dimColor: true, children: taskLabel })] }) })) : null, _jsx(InputArea, { status: status, skills: skillList, cwd: cwd, planningMode: planningMode, permissionRequest: permissionRequest, onPermissionResponse: resolvePermission, compactRequest: compactRequest, onCompactResponse: resolveCompact, onSubmit: handleSubmit, onAbort: handleAbort, history: historyRef.current.filter(m => m.role === 'user').map(m => m.content), watchActive: watchActive })] }));
}
