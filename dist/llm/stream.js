// Transient errors worth retrying: rate limits + server-side faults
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 4;
const MAX_DELAY_MS = 30_000;
function retryDelay(attempt) {
    // Exponential backoff: 1s → 2s → 4s → 8s, capped at 30s, ±20% jitter
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
    const { model, messages, baseUrl, apiKey, signal, onDone, onError, onUsage, onChunk, onRetry } = cfg;
    try {
        const res = await fetchWithRetry(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? 'local'}` },
            body: JSON.stringify({ model, messages, stream: !!onChunk }),
        }, signal, onRetry);
        if (!res.ok) {
            onError(new Error(`LLM ${res.status}: ${await res.text()}`));
            return;
        }
        if (!onChunk) {
            const obj = await res.json();
            onUsage?.(obj?.usage?.prompt_tokens ?? 0, obj?.usage?.completion_tokens ?? 0);
            await onDone(obj?.choices?.[0]?.message?.content ?? '');
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        let buf = '';
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
                    const chunk = obj?.choices?.[0]?.delta?.content ?? '';
                    if (chunk) {
                        full += chunk;
                        onChunk(chunk);
                    }
                }
                catch { }
            }
        }
        await onDone(full);
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
async function chatAnthropic(cfg) {
    const { model, messages, baseUrl, apiKey, signal, onDone, onError, onUsage, onRetry } = cfg;
    const url = baseUrl && baseUrl !== 'http://localhost:11434'
        ? `${baseUrl}/v1/messages`
        : 'https://api.anthropic.com/v1/messages';
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const filtered = messages.filter(m => m.role !== 'system');
    try {
        const body = {
            model,
            max_tokens: 8192,
            messages: filtered,
        };
        if (systemParts.length)
            body.system = systemParts.join('\n\n');
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
        const obj = await res.json();
        const text = (obj.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
        onUsage?.(obj.usage?.input_tokens ?? 0, obj.usage?.output_tokens ?? 0);
        await onDone(text);
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
function toError(e) {
    return e instanceof Error ? e : new Error(String(e));
}
