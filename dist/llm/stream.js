export async function chat(cfg) {
    if (cfg.provider === 'openai-compat')
        return chatOpenAI(cfg);
    return chatOllama(cfg);
}
async function chatOllama(cfg) {
    const { model, messages, baseUrl, signal, onDone, onError, onUsage } = cfg;
    try {
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, stream: false }),
            signal,
        });
        if (!res.ok) {
            onError(new Error(`Ollama ${res.status}: ${await res.text()}`));
            return;
        }
        const obj = await res.json();
        onUsage?.(obj?.prompt_eval_count ?? 0, obj?.eval_count ?? 0);
        await onDone(obj?.message?.content ?? '');
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
async function chatOpenAI(cfg) {
    const { model, messages, baseUrl, apiKey, signal, onDone, onError, onUsage } = cfg;
    try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? 'local'}` },
            body: JSON.stringify({ model, messages }),
            signal,
        });
        if (!res.ok) {
            onError(new Error(`LLM ${res.status}: ${await res.text()}`));
            return;
        }
        const obj = await res.json();
        onUsage?.(obj?.usage?.prompt_tokens ?? 0, obj?.usage?.completion_tokens ?? 0);
        await onDone(obj?.choices?.[0]?.message?.content ?? '');
    }
    catch (err) {
        if (err?.name !== 'AbortError')
            onError(toError(err));
    }
}
function toError(e) {
    return e instanceof Error ? e : new Error(String(e));
}
