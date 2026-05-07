import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, useStdout, useInput } from 'ink';
import { StatusBar, Divider } from './components/StatusBar.js';
import { MessageList } from './components/MessageList.js';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
import { stream } from '../llm/stream.js';
import { listModels, pullModel } from '../llm/ollama.js';
import { StreamParser } from '../parser/stream-parser.js';
import { tools, getSystemPrompt } from '../tools/index.js';
import { readFile, guardPath } from '../files/ops.js';
import { generateId } from '../types.js';
const MAX_TOOL_DEPTH = 6;
const RENDER_THROTTLE_MS = 40;
function expandAtRefs(text, cwd) {
    const refs = [...text.matchAll(/@([\w./\-]+)/g)];
    if (!refs.length)
        return { displayText: text, contextPrefix: '' };
    const parts = [];
    for (const m of refs) {
        try {
            const safePath = guardPath(m[1], cwd);
            const content = readFile(safePath);
            parts.push(`<file path="${m[1]}">\n${content}\n</file>`);
        }
        catch { }
    }
    return { displayText: text, contextPrefix: parts.length ? parts.join('\n\n') + '\n\n' : '' };
}
export function App({ config, skills, cwd }) {
    const { stdout } = useStdout();
    const [messages, setMessages] = useState([{
            id: 'welcome',
            role: 'system',
            content: `local AI coding assistant  ·  ${config.provider}/${config.model}  ·  cwd: ${cwd}`,
            timestamp: Date.now(),
        }]);
    const [status, setStatus] = useState('idle');
    const [tick, setTick] = useState(0);
    const [currentModel, setCurrentModel] = useState(config.model);
    const [scrollOffset, setScrollOffset] = useState(0);
    // model picker
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerModels, setPickerModels] = useState([]);
    const [pickerLoading, setPickerLoading] = useState(false);
    const [pickerError, setPickerError] = useState();
    const [pullState, setPullState] = useState();
    const [systemPrompt, setSystemPrompt] = useState(() => getSystemPrompt(`\n- CWD: ${cwd}`));
    const systemPromptRef = useRef(systemPrompt);
    const currentModelRef = useRef(currentModel);
    const abortRef = useRef(null);
    const pullAbortRef = useRef(null);
    const tokenBufRef = useRef('');
    const lastRenderRef = useRef(0);
    const messagesRef = useRef(messages);
    useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
    useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    useEffect(() => {
        if (status === 'idle')
            return;
        const t = setInterval(() => setTick(n => n + 1), 80);
        return () => clearInterval(t);
    }, [status]);
    // Scroll keybindings — PageUp/PageDn scroll message history
    const SCROLL_STEP = 5;
    useInput((_input, key) => {
        if (pickerOpen)
            return;
        if (key.pageUp) {
            setScrollOffset(n => Math.min(n + SCROLL_STEP, Math.max(0, messages.length - 1)));
        }
        if (key.pageDown) {
            setScrollOffset(n => Math.max(0, n - SCROLL_STEP));
        }
    });
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    function addMsg(role, content, id) {
        const mid = id ?? generateId();
        setMessages(prev => [...prev, { id: mid, role, content, timestamp: Date.now() }]);
        return mid;
    }
    function buildContext(extra) {
        const ctx = [{ role: 'system', content: systemPromptRef.current }];
        for (const m of messagesRef.current) {
            if (m.role === 'tool')
                ctx.push({ role: 'user', content: `[tool result]\n${m.content}` });
            else if (m.role === 'user' || m.role === 'assistant')
                ctx.push({ role: m.role, content: m.content });
        }
        if (extra)
            ctx.push(extra);
        return ctx;
    }
    const runLoop = useCallback(async (contextMsgs, depth = 0) => {
        if (depth >= MAX_TOOL_DEPTH) {
            setStatus('idle');
            return;
        }
        setStatus('streaming');
        const assistantId = generateId();
        setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: Date.now() }]);
        const parser = new StreamParser();
        const pendingTools = [];
        let fullText = '';
        abortRef.current = new AbortController();
        await stream({
            provider: config.provider,
            model: currentModelRef.current,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            messages: contextMsgs,
            signal: abortRef.current.signal,
            onToken(token) {
                fullText += token;
                tokenBufRef.current += token;
                const now = Date.now();
                if (now - lastRenderRef.current >= RENDER_THROTTLE_MS) {
                    const flush = tokenBufRef.current;
                    tokenBufRef.current = '';
                    lastRenderRef.current = now;
                    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + flush } : m));
                }
                for (const item of parser.feed(token)) {
                    if (item.type === 'tool_call')
                        pendingTools.push({ name: item.toolName, args: item.toolArgs });
                }
            },
            async onDone() {
                if (tokenBufRef.current) {
                    const flush = tokenBufRef.current;
                    tokenBufRef.current = '';
                    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + flush } : m));
                }
                for (const item of parser.flush()) {
                    if (item.type === 'tool_call')
                        pendingTools.push({ name: item.toolName, args: item.toolArgs });
                }
                if (!pendingTools.length) {
                    setStatus('idle');
                    return;
                }
                setStatus('tool');
                const next = [...contextMsgs, { role: 'assistant', content: fullText }];
                for (const tc of pendingTools) {
                    const tool = tools.find(t => t.name === tc.name);
                    const toolId = generateId();
                    if (tool) {
                        try {
                            const result = await tool.execute(tc.args);
                            setMessages(prev => [...prev, { id: toolId, role: 'tool', content: `[${tc.name}]\n${result}`, timestamp: Date.now() }]);
                            next.push({ role: 'user', content: `Tool ${tc.name} result:\n${result}` });
                        }
                        catch (e) {
                            const err = `Tool ${tc.name} error: ${e}`;
                            setMessages(prev => [...prev, { id: toolId, role: 'tool', content: err, timestamp: Date.now() }]);
                            next.push({ role: 'user', content: err });
                        }
                    }
                    else {
                        const unk = `Unknown tool: ${tc.name}`;
                        setMessages(prev => [...prev, { id: toolId, role: 'tool', content: unk, timestamp: Date.now() }]);
                        next.push({ role: 'user', content: unk });
                    }
                }
                await runLoop(next, depth + 1);
            },
            onError(err) {
                addMsg('system', `error: ${err.message}`);
                setStatus('idle');
            },
        });
    }, [config]);
    // Model picker
    const openPicker = useCallback(async () => {
        setPickerOpen(true);
        setPickerLoading(true);
        setPickerError(undefined);
        try {
            setPickerModels(await listModels(config.baseUrl));
        }
        catch (e) {
            setPickerError(String(e));
        }
        finally {
            setPickerLoading(false);
        }
    }, [config.baseUrl]);
    const handleModelSelect = useCallback((name) => {
        setCurrentModel(name);
        setPickerOpen(false);
        addMsg('system', `model → ${name}`);
    }, []);
    const handleModelPull = useCallback(async (name) => {
        setPullState({ name, status: 'starting...', pct: undefined });
        pullAbortRef.current = new AbortController();
        try {
            await pullModel(config.baseUrl, name, (s, p) => setPullState({ name, status: s, pct: p }), pullAbortRef.current.signal);
            setPickerModels(await listModels(config.baseUrl));
            setPullState(undefined);
            setCurrentModel(name);
            setPickerOpen(false);
            addMsg('system', `pulled ${name} → active`);
        }
        catch (e) {
            setPullState(undefined);
            setPickerError(`pull failed: ${e}`);
        }
    }, [config.baseUrl]);
    const handleSubmit = useCallback(async (text) => {
        setScrollOffset(0); // snap to bottom on new message
        if (text.trim() === '/models') {
            await openPicker();
            return;
        }
        if (text.startsWith('/')) {
            const [cmd, ...rest] = text.slice(1).split(' ');
            const skill = skills.get(cmd);
            if (skill) {
                if (skill.name === 'list') {
                    addMsg('system', skills.list().map(s => `/${s.ns === 'default' ? '' : s.ns + ':'}${s.name}  — ${s.description}`).join('\n'));
                    return;
                }
                if (skill.execute) {
                    const ctx = {
                        messages: messagesRef.current.map(m => ({ role: m.role, content: m.content })),
                        appendMessage: (role, content) => addMsg(role, content),
                        setSystemPrompt: (p) => setSystemPrompt(p),
                        getSystemPrompt: () => systemPromptRef.current,
                    };
                    const result = await skill.execute(rest.join(' '), ctx);
                    if (result)
                        addMsg('system', result);
                    return;
                }
                if (skill.prompt) {
                    addMsg('user', skill.prompt);
                    await runLoop(buildContext({ role: 'user', content: skill.prompt }));
                    return;
                }
            }
            addMsg('system', `unknown skill: /${cmd}. Try /list`);
            return;
        }
        // Expand @file references
        const { displayText, contextPrefix } = expandAtRefs(text, cwd);
        addMsg('user', displayText);
        const llmContent = contextPrefix + text;
        await runLoop(buildContext({ role: 'user', content: llmContent }));
    }, [skills, runLoop, openPicker]);
    const handleAbort = useCallback(() => {
        abortRef.current?.abort();
        setStatus('idle');
        tokenBufRef.current = '';
    }, []);
    const skillList = skills.list();
    return (_jsxs(Box, { flexDirection: "column", height: rows, children: [_jsx(StatusBar, { model: currentModel, provider: config.provider, status: status, tick: tick }), _jsx(Divider, { cols: cols }), pickerOpen ? (_jsx(ModelPicker, { models: pickerModels, current: currentModel, loading: pickerLoading, error: pickerError, pull: pullState, onSelect: handleModelSelect, onPull: handleModelPull, onClose: () => { setPickerOpen(false); setPullState(undefined); } })) : (_jsx(MessageList, { messages: messages, rows: rows - 8, cols: cols, scrollOffset: scrollOffset, streaming: status === 'streaming' })), _jsx(Divider, { cols: cols }), _jsx(InputArea, { status: status, skills: skillList, cwd: cwd, onSubmit: handleSubmit, onAbort: handleAbort })] }));
}
//# sourceMappingURL=App.js.map