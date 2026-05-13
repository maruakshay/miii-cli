import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useMemo, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
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
function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
export function InputBar({ config, skills, cwd, session, version }) {
    const { stdout, write: stdoutWrite } = useStdout();
    const cols = stdout.columns ?? 80;
    useEffect(() => { setInkInstance(stdoutWrite); }, []);
    const phraseSeq = useMemo(() => Array.from({ length: 100 }, () => Math.floor(Math.random() * THINKING_PHRASES.length)), []);
    const [planningMode, setPlanningMode] = useState(false);
    const macroQueueRef = useRef(new MacroQueue());
    const executorRef = useRef(new TaskExecutor(tools));
    const lastGitStatusRef = useRef('');
    const abortRef = useRef(null);
    const { setSessionName, sessionNameRef, historyRef, saveTimerRef, systemPromptRef, pushHistory, buildContext, renameFromMessage, } = useSession(session, cwd, config);
    const { currentModel, setCurrentModel, currentModelRef, pickerOpen, setPickerOpen, pickerModels, pickerLoading, pickerError, pullState, openPicker, handleModelSelect, handleModelPull, } = useModelPicker(config);
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
    const allTools = useMemo(() => [...tools, deepThinkTool, searchTool], [deepThinkTool, searchTool]);
    const { status, setStatus, tick, currentTool, setCurrentTool, taskLabel, setTaskLabel, thinkingStartRef, runLoop, handleAbort, permissionRequest, resolvePermission, } = useRunLoop(config, currentModelRef, pushHistory, allTools, abortRef);
    const { runRefactor } = useRefactor({
        config, currentModelRef, systemPromptRef, abortRef,
        macroQueueRef, executorRef,
        setStatus, setTaskLabel, setCurrentTool, pushHistory,
    });
    const { handleGit } = useGit({ pushHistory, buildContext, runLoop });
    const { handleSubmit } = useSubmit({
        config, skills, cwd, version, currentModelRef, setCurrentModel,
        historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
        planningMode, setPlanningMode, runLoop, buildContext, pushHistory,
        setSessionName, renameFromMessage, openPicker,
        setStatus, setTaskLabel, setCurrentTool,
        runRefactor, handleGit, lastGitStatusRef,
    });
    const skillList = skills.list();
    return (_jsxs(Box, { flexDirection: "column", children: [pickerOpen ? (_jsxs(_Fragment, { children: [_jsx(ModelPicker, { models: pickerModels, current: currentModel, loading: pickerLoading, error: pickerError, pull: pullState, onSelect: handleModelSelect, onPull: handleModelPull, onClose: () => { setPickerOpen(false); } }), _jsx(Divider, { cols: cols })] })) : permissionRequest ? (_jsxs(Box, { paddingX: 1, gap: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0" }), _jsx(Text, { color: "white", bold: true, children: permissionRequest.toolName }), _jsx(Text, { color: "gray", children: toolArgSummary(permissionRequest.args) })] })) : (status === 'thinking' || status === 'tool') ? (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Box, { children: status === 'thinking'
                            ? _jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", children: [SPARKLE[tick % SPARKLE.length], " "] }), _jsx(Text, { color: "gray", dimColor: true, italic: true, children: THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]] })] })
                            : _jsxs(Text, { color: "yellow", dimColor: true, children: ["\u2699 running ", currentTool ?? 'tool', "\u2026"] }) }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: "gray", dimColor: true, children: formatElapsed(Date.now() - thinkingStartRef.current) }), taskLabel && _jsx(Text, { color: "cyan", dimColor: true, children: taskLabel })] })] })) : null, _jsx(InputArea, { status: status, skills: skillList, cwd: cwd, planningMode: planningMode, permissionRequest: permissionRequest, onPermissionResponse: resolvePermission, onSubmit: handleSubmit, onAbort: handleAbort, history: historyRef.current.filter(m => m.role === 'user').map(m => m.content) })] }));
}
