import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useMemo, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
import { ConfigPicker } from './components/ConfigPicker.js';
import { Divider } from './components/StatusBar.js';
import { tools } from '../tools/index.js';
import { toolArgSummary } from './printer.js';
import { MacroQueue } from '../tasks/queue.js';
import { TaskExecutor } from '../tasks/executor.js';
import { THINKING_PHRASES, SPARKLE } from './thinking.js';
import { useSession } from './hooks/useSession.js';
import { useModelPicker } from './hooks/useModelPicker.js';
import { useRunLoop } from './hooks/useRunLoop.js';
import { useRefactor } from './hooks/useRefactor.js';
import { useGit } from './hooks/useGit.js';
import { useSubmit } from './hooks/useSubmit.js';
import { runDeepThink } from './deepThink.js';
import { setInkInstance } from './printer.js';
import { createSearchCodebaseTool } from '../index/tool.js';
import { saveConfig } from '../config.js';
import { getTavilyKey, saveTavilyKey } from '../tavily/client.js';
import { warmup } from '../llm/stream.js';
function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
const MAX_DIFF_LINES = 5;
function DiffPreview({ toolName, args }) {
    if (toolName === 'patch_file' && (args.old || args.new)) {
        const oldLines = String(args.old ?? '').split('\n');
        const newLines = String(args.new ?? '').split('\n');
        return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [oldLines.slice(0, MAX_DIFF_LINES).map((line, i) => (_jsxs(Text, { color: "red", dimColor: true, children: ["- ", line.slice(0, 72)] }, `o${i}`))), oldLines.length > MAX_DIFF_LINES && (_jsxs(Text, { color: "gray", dimColor: true, children: ["  \u2026", oldLines.length - MAX_DIFF_LINES, " more"] })), newLines.slice(0, MAX_DIFF_LINES).map((line, i) => (_jsxs(Text, { color: "green", dimColor: true, children: ["+ ", line.slice(0, 72)] }, `n${i}`))), newLines.length > MAX_DIFF_LINES && (_jsxs(Text, { color: "gray", dimColor: true, children: ["  \u2026", newLines.length - MAX_DIFF_LINES, " more"] }))] }));
    }
    if ((toolName === 'edit_file' || toolName === 'create_file') && args.content) {
        const n = String(args.content).split('\n').length;
        return (_jsx(Box, { paddingLeft: 2, children: _jsxs(Text, { color: "gray", dimColor: true, children: [n, " line", n === 1 ? '' : 's'] }) }));
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
    const { handleSubmit } = useSubmit({
        config, skills, cwd, projectDir, version, currentModelRef, setCurrentModel,
        historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
        setPlanningMode, runLoop, buildContext, pushHistory,
        setSessionName, renameFromMessage,
        setStatus, setTaskLabel, setCurrentTool,
        runRefactor, handleGit, lastGitStatusRef, mcpTools, setConfig,
        setConfigOpen, updateMemory,
    });
    const skillList = skills.list();
    return (_jsxs(Box, { flexDirection: "column", children: [configOpen ? (_jsxs(_Fragment, { children: [_jsx(ConfigPicker, { config: config, currentModel: currentModel, tavilyKey: tavilyKey, onUpdate: ({ model, ...configPatch }) => {
                            if (model)
                                setCurrentModel(model);
                            if (Object.keys(configPatch).length) {
                                setConfig(c => ({ ...c, ...configPatch }));
                                saveConfig(configPatch);
                            }
                        }, onTavilyKey: (key) => { saveTavilyKey(key); setTavilyKey(key); }, onClose: () => { setConfigOpen(false); } }), _jsx(Divider, { cols: cols })] })) : pickerOpen ? (_jsxs(_Fragment, { children: [_jsx(ModelPicker, { models: pickerModels, current: currentModel, loading: pickerLoading, error: pickerError, pull: pullState, onSelect: handleModelSelect, onPull: handleModelPull, onClose: () => { setPickerOpen(false); } }), _jsx(Divider, { cols: cols })] })) : compactRequest ? (_jsxs(Box, { paddingX: 1, flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0" }), _jsx(Text, { color: "white", bold: true, children: "context is large" }), _jsxs(Text, { color: "gray", children: ["(~", compactRequest.messageCount, "k chars)"] })] }), _jsx(Text, { color: "gray", dimColor: true, children: "compact to keep responses fast, or keep full history" })] })) : permissionRequest ? (_jsxs(Box, { paddingX: 1, flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0" }), _jsx(Text, { color: "white", bold: true, children: permissionRequest.toolName }), _jsx(Text, { color: "gray", children: toolArgSummary(permissionRequest.args) })] }), _jsx(DiffPreview, { toolName: permissionRequest.toolName, args: permissionRequest.args })] })) : (status === 'thinking' || status === 'tool') ? (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Box, { children: status === 'thinking'
                            ? _jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", children: [SPARKLE[tick % SPARKLE.length], " "] }), _jsx(Text, { color: "gray", dimColor: true, italic: true, children: THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]] })] })
                            : _jsxs(Text, { color: "yellow", dimColor: true, children: ["\u2699 running ", currentTool ?? 'tool', "\u2026"] }) }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: "gray", dimColor: true, children: formatElapsed(Date.now() - thinkingStartRef.current) }), taskLabel && _jsx(Text, { color: "cyan", dimColor: true, children: taskLabel })] })] })) : null, _jsx(InputArea, { status: status, skills: skillList, cwd: cwd, planningMode: planningMode, permissionRequest: permissionRequest, onPermissionResponse: resolvePermission, compactRequest: compactRequest, onCompactResponse: resolveCompact, onSubmit: handleSubmit, onAbort: handleAbort, history: historyRef.current.filter(m => m.role === 'user').map(m => m.content) })] }));
}
