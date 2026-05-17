const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 4;
const MAX_DELAY_MS = 30_000;
function retryDelay(attempt) {
    const base = 1_000 * Math.pow(2, attempt);
    const capped = Math.min(base, MAX_DELAY_MS);
    return Math.round(capped * (0.8 + Math.random() * 0.4));
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
}
async function fetchWithRetry(url, init, signal, onRetry) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let res;
        try {
            res = await fetch(url, { ...init, signal });
        }
        catch (err) {
            if (err?.name === 'AbortError')
                throw err;
            if (attempt === MAX_RETRIES)
                throw err;
            const delayMs = retryDelay(attempt);
            onRetry?.(attempt + 1, MAX_RETRIES, delayMs);
            await sleep(delayMs, signal);
            continue;
        }
        if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES)
            return res;
        const retryAfterSec = Number(res.headers.get('retry-after') ?? 0);
        const delayMs = retryAfterSec > 0 ? retryAfterSec * 1000 : retryDelay(attempt);
        onRetry?.(attempt + 1, MAX_RETRIES, delayMs);
        await sleep(delayMs, signal);
    }
    throw new Error('fetchWithRetry: exhausted retries without returning');
}
// Convert Tool params string to JSON Schema for native tool_calls APIs
function paramsToSchema(paramsStr) {
    try {
        const obj = JSON.parse(paramsStr);
        const properties = {};
        const required = [];
        for (const [key, typeStr] of Object.entries(obj)) {
            const isOptional = typeStr.toLowerCase().includes('optional');
            const isArray = typeStr.toLowerCase().includes('[]') || typeStr.toLowerCase().startsWith('array');
            const base = typeStr.split(' ')[0].toLowerCase().replace('[]', '');
            if (isArray) {
                properties[key] = { type: 'array', items: { type: 'string' } };
            }
            else if (base === 'boolean') {
                properties[key] = { type: 'boolean' };
            }
            else if (base === 'number') {
                properties[key] = { type: 'number' };
            }
            else {
                properties[key] = { type: 'string' };
            }
            if (!isOptional)
                required.push(key);
        }
        return { type: 'object', properties, required };
    }
    catch {
        return { type: 'object', properties: {}, required: [] };
    }
}
export async function warmup(provider, baseUrl, model) {
    if (provider !== 'ollama')
        return;
    try {
        await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: '10m' }),
            signal: AbortSignal.timeout(30_000),
        });
    }
    catch { }
}
export async function chat(cfg) {
    if (cfg.provider === 'anthropic')
        return chatAnthropic(cfg);
    if (cfg.provider === 'openai-compat')
        return chatOpenAI(cfg);
    return chatOllama(cfg);
}
async function chatOllama(cfg) {
    const { model, messages, baseUrl, signal, onDone, onError, onUsage, onChunk, onRetry } = cfg;
    try {
        const res = await fetchWithRetry(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, stream: !!onChunk }),
        }, signal, onRetry);
        if (!res.ok) {
            onError(new Error(`Ollama ${res.status}: ${await res.text()}`));
            return;
        }
        if (!onChunk) {
            const obj = await res.json();
            onUsage?.(obj?.prompt_eval_count ?? 0, obj?.eval_count ?? 0);
            await onDone(obj?.message?.content ?? '');
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const obj = JSON.parse(line);
                    const chunk = obj?.message?.content ?? '';
                    if (chunk) {
                        full += chunk;
                        onChunk(chunk);
                    }
                    if (obj?.done) {
                        promptTokens = obj.prompt_eval_count ?? 0;
                        completionTokens = obj.eval_count ?? 0;
                    }
                }
                catch { }
            }
        }
        onUsage?.(promptTokens, completionTokens);
        await onDone(full);
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
async function chatOpenAI(cfg) {
    const { model, messages, baseUrl, apiKey, signal, onDone, onError, onUsage, onChunk, onRetry, tools, toolChoice } = cfg;
    const body = { model, messages, stream: !!onChunk };
    if (tools?.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: paramsToSchema(t.params) },
        }));
        if (toolChoice === 'none')
            body.tool_choice = 'none';
    }
    try {
        const res = await fetchWithRetry(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? 'local'}` },
            body: JSON.stringify(body),
        }, signal, onRetry);
        if (!res.ok) {
            onError(new Error(`LLM ${res.status}: ${await res.text()}`));
            return;
        }
        if (!onChunk) {
            const obj = await res.json();
            onUsage?.(obj?.usage?.prompt_tokens ?? 0, obj?.usage?.completion_tokens ?? 0);
            const message = obj?.choices?.[0]?.message;
            let text = message?.content ?? '';
            if (message?.tool_calls?.length) {
                for (const tc of message.tool_calls) {
                    let args = {};
                    try {
                        args = JSON.parse(tc.function?.arguments ?? '{}');
                    }
                    catch { }
                    text += `\n<tool_call>\n{"name": ${JSON.stringify(tc.function?.name)}, "args": ${JSON.stringify(args)}}\n</tool_call>`;
                }
            }
            await onDone(text);
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        let buf = '';
        const tcAccum = {};
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]')
                    continue;
                try {
                    const obj = JSON.parse(data);
                    const delta = obj?.choices?.[0]?.delta;
                    if (!delta)
                        continue;
                    const chunk = delta.content ?? '';
                    if (chunk) {
                        full += chunk;
                        onChunk(chunk);
                    }
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!tcAccum[idx])
                                tcAccum[idx] = { id: '', name: '', args: '' };
                            if (tc.id)
                                tcAccum[idx].id = tc.id;
                            if (tc.function?.name)
                                tcAccum[idx].name += tc.function.name;
                            if (tc.function?.arguments)
                                tcAccum[idx].args += tc.function.arguments;
                        }
                    }
                }
                catch { }
            }
        }
        // Serialize accumulated tool_calls to XML for run loop compatibility
        for (const idx of Object.keys(tcAccum).map(Number).sort((a, b) => a - b)) {
            const tc = tcAccum[idx];
            let args = {};
            try {
                args = JSON.parse(tc.args);
            }
            catch { }
            full += `\n<tool_call>\n{"name": ${JSON.stringify(tc.name)}, "args": ${JSON.stringify(args)}}\n</tool_call>`;
        }
        await onDone(full);
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
async function chatAnthropic(cfg) {
    const { model, messages, baseUrl, apiKey, signal, onDone, onError, onUsage, onChunk, onRetry, tools, toolChoice } = cfg;
    const url = baseUrl && baseUrl !== 'http://localhost:11434'
        ? `${baseUrl}/v1/messages`
        : 'https://api.anthropic.com/v1/messages';
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const filtered = messages.filter(m => m.role !== 'system');
    const body = {
        model,
        max_tokens: 8192,
        stream: !!onChunk,
        messages: filtered,
    };
    if (systemParts.length)
        body.system = systemParts.join('\n\n');
    if (tools?.length) {
        body.tools = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: paramsToSchema(t.params),
        }));
        if (toolChoice === 'none')
            body.tool_choice = { type: 'none' };
    }
    try {
        const res = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey ?? '',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        }, signal, onRetry);
        if (!res.ok) {
            onError(new Error(`Anthropic ${res.status}: ${await res.text()}`));
            return;
        }
        if (!onChunk) {
            const obj = await res.json();
            let fullText = '';
            for (const block of obj?.content ?? []) {
                if (block.type === 'text')
                    fullText += block.text ?? '';
                else if (block.type === 'tool_use') {
                    const args = block.input ?? {};
                    fullText += `\n<tool_call>\n{"name": ${JSON.stringify(block.name ?? '')}, "args": ${JSON.stringify(args)}}\n</tool_call>`;
                }
            }
            onUsage?.(obj?.usage?.input_tokens ?? 0, obj?.usage?.output_tokens ?? 0);
            await onDone(fullText);
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let fullText = '';
        let promptTokens = 0;
        let completionTokens = 0;
        // Track native tool_use content blocks
        const toolBlocks = [];
        let activeToolIdx = -1;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (!data || data === '[DONE]')
                    continue;
                try {
                    const evt = JSON.parse(data);
                    if (evt.type === 'message_start') {
                        promptTokens = (evt.message?.usage?.input_tokens) ?? 0;
                    }
                    else if (evt.type === 'content_block_start') {
                        const block = evt.content_block;
                        if (block.type === 'tool_use') {
                            activeToolIdx = toolBlocks.length;
                            toolBlocks.push({ id: block.id ?? '', name: block.name ?? '', inputJson: '' });
                        }
                    }
                    else if (evt.type === 'content_block_delta') {
                        const delta = evt.delta;
                        if (delta.type === 'text_delta' && delta.text) {
                            fullText += delta.text;
                            onChunk?.(delta.text);
                        }
                        else if (delta.type === 'input_json_delta' && activeToolIdx >= 0) {
                            toolBlocks[activeToolIdx].inputJson += delta.partial_json ?? '';
                        }
                    }
                    else if (evt.type === 'content_block_stop') {
                        activeToolIdx = -1;
                    }
                    else if (evt.type === 'message_delta') {
                        completionTokens = (evt.usage?.output_tokens) ?? 0;
                    }
                }
                catch { }
            }
        }
        // Serialize native tool_use blocks to XML for run loop compatibility
        for (const block of toolBlocks) {
            let args = {};
            try {
                args = JSON.parse(block.inputJson);
            }
            catch { }
            fullText += `\n<tool_call>\n{"name": ${JSON.stringify(block.name)}, "args": ${JSON.stringify(args)}}\n</tool_call>`;
        }
        onUsage?.(promptTokens, completionTokens);
        await onDone(fullText);
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
function toError(e) {
    return e instanceof Error ? e : new Error(String(e));
}
