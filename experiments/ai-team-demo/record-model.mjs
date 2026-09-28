// Explicit opt-in capture. Sends only the disposable fixture and its checks.
// Saves text for human inspection; never executes model output.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
let key = process.env.OPENROUTER_API_KEY;
if (!key && process.env.DEMO_PROVIDER_ENV_FILE) {
  const env = await readFile(process.env.DEMO_PROVIDER_ENV_FILE, 'utf8');
  key = env.match(/^OPENROUTER_API_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
}
if (!key) throw new Error('Set OPENROUTER_API_KEY or DEMO_PROVIDER_ENV_FILE explicitly.');
const model = 'cohere/north-mini-code:free';
const before = await readFile(new URL('fixtures/before.mjs', root), 'utf8');
const checks = await readFile(new URL('fixtures/checks.mjs', root), 'utf8');
async function call(role, prompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, reasoning: { effort: 'none' }, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`Free provider returned HTTP ${response.status}; no paid fallback.`);
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('No model content returned.');
  let output;
  try { output = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); }
  catch {
    // Some free endpoints ignore JSON mode. Preserve the response as text;
    // this script does not treat parsing or model review as acceptance.
    output = role === 'builder' ? { source: raw.replace(/^```(?:javascript|js|mjs)?\s*|\s*```$/g, '') } : { summary: raw, verdict: 'unstructured-review' };
  }
  return { role, model: data.model, capturedAt: new Date().toISOString(), finishReason: data.choices[0].finish_reason, usage: data.usage, output };
}
const builder = await call('builder', `You are the builder in a disposable demonstration. Fix this tiny JavaScript function. Inputs are arrays of objects with stable string id fields. Preserve first-seen order, latest value wins, no input mutation. Return only a JSON object with keys source (complete ES module exporting reconcileEvents), summary (brief human-readable explanation), handoff (brief note for an independent verifier). Do not use imports, IO, network, dynamic code, or third-party dependencies.\nSOURCE:\n${before}\nCHECKS:\n${checks}`);
// Second session has no builder conversation history, only the shared task bundle.
const verifier = await call('verifier', `You are a separate reviewer of a disposable example. Another worker already owns the fix; you may review, not overwrite it. Read the proposed source and fixed tests. Return only a JSON object with keys verdict (approve or request_changes), summary, limitations. This is static review only: do not claim you executed tests.\nTASK: reconnect replay must not duplicate event ids; preserve first-seen order, latest value wins; never mutate input arrays.\nPROPOSED SOURCE:\n${builder.output.source}\nCHECKS:\n${checks}`);
await writeFile(new URL('recording.proposed.json', root), JSON.stringify({ schema: 1, mode: 'recorded-real-model-sessions', builder, verifier }, null, 2) + '\n');
console.log(JSON.stringify({ saved: 'recording.proposed.json', builderModel: builder.model, verifierModel: verifier.model, verdict: verifier.output.verdict }));
