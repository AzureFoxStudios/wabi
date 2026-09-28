const $ = selector => document.querySelector(selector);
const labels = { 'worker-a': 'Aster · session A', 'worker-b': 'Moss · session B', human: 'You · human reviewer', system: 'Local test runner' };
const letters = { 'worker-a': 'A', 'worker-b': 'M', human: 'Y', system: '✓' };
let state, token, tab = 'change', busy = false;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = value => value?.slice(0, 12) || '—';
const otherWorker = () => state.owner === 'worker-a' ? 'worker-b' : 'worker-a';
const index = () => ({ ready: 0, open: 1, working: 2, review: state.verification ? 4 : 3, done: 5 }[state.phase]);
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Cannot read the demo.');
  ({ state, token } = await response.json());
  render();
}
async function action(action, actor, extra = {}) {
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Token': token }, body: JSON.stringify({ action, actor, requestId: crypto.randomUUID(), expectedRevision: state.revision, ...extra }) });
  const result = await response.json();
  if (!response.ok && result.outcome !== 'conflict') throw new Error(result.error || 'Action failed.');
  return result;
}
async function work(callback) {
  if (busy) return;
  busy = true; $('#error').hidden = true; render();
  try { await callback(); }
  catch (error) { $('#error').hidden = false; $('#error').textContent = error.message; }
  finally { busy = false; try { await refresh(); } catch (error) { $('#error').hidden = false; $('#error').textContent = error.message; } }
}
$('#advance').addEventListener('click', () => work(async () => {
  const step = index();
  if (step === 0) await action('reproduce', 'human');
  if (step === 1) await Promise.all([action('claim', 'worker-a'), action('claim', 'worker-b')]);
  if (step === 2) await action('propose', state.owner);
  if (step === 3) { await action('verify', otherWorker()); tab = 'checks'; }
  if (step === 4) { await action('accept', 'human', { candidateHash: state.candidate.hash }); tab = 'handoff'; }
  if (step === 5) { await action('new-run', 'human'); tab = 'change'; }
}));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab; render(); }));
// Standard arrow-key navigation for the evidence tablist.
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const keys = ['change', 'checks', 'handoff'];
  tab = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : keys[(keys.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
  render(); $(`#tab-${tab}`).focus();
});
$('#comment-form').addEventListener('submit', event => { event.preventDefault(); const text = $('#comment').value; if (!text.trim()) return; work(async () => { await action('comment', 'human', { text }); $('#comment').value = ''; }); });
function render() {
  if (!state) return;
  const step = index();
  const titles = ['Start with a failure you can reproduce.', 'Two sessions. One editing claim.', 'Bring the proposal into the shared record.', 'Check the change in a separate folder.', 'The checked version is ready for your decision.', 'Accepted. Ready for the next session.'];
  const descriptions = ['Run the fixture against the original code. Expect a real failing test.', 'Send competing requests. The second session takes the review role.', 'Replay the inspected free-model proposal into the owner’s working folder.', 'The other session gets a copy; the local runner executes all six checks.', 'Acceptance is tied to the exact source hash that passed the checks.', 'The brief, ownership, source and evidence remain saved together.'];
  const buttons = ['Reproduce bug', 'Try competing claims', 'Load AI proposal', 'Run verification', 'Accept this version', 'Start a fresh demo'];
  $('#next-title').textContent = titles[step]; $('#next-description').textContent = descriptions[step];
  $('#advance').textContent = busy ? 'Working…' : buttons[step] + ' →'; $('#advance').disabled = busy;
  document.querySelectorAll('[data-step]').forEach(element => { const n = Number(element.dataset.step); element.className = n < step ? 'complete' : n === step ? 'current' : ''; if (n === step) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current'); });
  $('#phase').textContent = { ready: 'To do', open: 'Ready to claim', working: 'In progress', review: 'In review', done: 'Accepted' }[state.phase];
  $('#owner').textContent = state.owner ? labels[state.owner] : 'Unclaimed';
  $('#reviewer').textContent = state.verification ? `${labels[state.verification.reviewer]} · checked` : state.owner && state.claims.some(c => c.outcome === 'conflict') ? `${labels[otherWorker()]} · waiting` : 'Waiting for proposal';
  $('#revision').textContent = `Saved revision ${state.revision} · ${state.environment.node}`;
  $('#check-count').textContent = state.verification?.exitCode === 0 ? '✓' : '';
  document.querySelectorAll('[data-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === tab)); button.tabIndex = button.dataset.tab === tab ? 0 : -1; });
  $('#evidence').setAttribute('aria-labelledby', `tab-${tab}`);
  if (tab === 'change') $('#evidence').innerHTML = `<div class="source-label"><span>BEFORE · candidate.mjs</span><code>${short(state.baseline?.sourceHash)}</code></div><pre>${escape(state.source.before)}</pre>` + (state.candidate ? `<div class="source-label"><span>PROPOSED · recorded AI output</span><code>${short(state.candidate.hash)}</code></div><pre class="after">${escape(state.source.after)}</pre>` : '<div class="empty"><strong>A small change. An inspectable trail.</strong>The proposed source will appear here after a worker claims the card.</div>');
  if (tab === 'checks') $('#evidence').innerHTML = `<div class="check-row"><span>Original reproduction</span><strong class="${state.baseline ? 'bad' : ''}">${state.baseline ? 'Failed as expected' : 'Not run'}</strong></div><div class="check-row"><span>Independent candidate check</span><strong class="${state.verification?.exitCode === 0 ? 'good' : ''}">${state.verification ? state.verification.exitCode === 0 ? '6 / 6 passed' : 'Failed' : 'Not run'}</strong></div>` + ['baseline', 'verification'].filter(k => state[k]).map(k => `<details><summary>${k === 'baseline' ? 'Reproduction' : 'Verification'} · actual runner output</summary><p class="source-label">Source ${short(state[k].sourceHash)} · tests ${short(state[k].checksHash)}</p><pre>${escape(state[k].stdout)}${escape(state[k].stderr)}</pre></details>`).join('') + '<p class="thread-note">Model review is an opinion. These results come from the local Node test runner.</p>';
  if (tab === 'handoff') $('#evidence').innerHTML = `<div class="handoff"><strong>${state.accepted ? 'Continue without the private chats.' : 'A shared record is taking shape.'}</strong><p>Task: remove duplicate event IDs after reconnect.<br>Owner: ${escape(state.owner ? labels[state.owner] : 'not claimed')}<br>Candidate: <code>${escape(state.candidate?.hash || 'not proposed')}</code><br>Checks: ${state.verification?.exitCode === 0 ? 'six passed on this candidate' : 'awaiting verification'}<br>Decision: ${state.accepted ? 'accepted by the human demo role' : 'awaiting human acceptance'}</p><p>Next: apply this pattern to an actual Wabi card, authenticated tool sessions and a repository adapter. This demo does not merge code or push to Lore.</p></div>`;
  $('#comments').innerHTML = state.comments.length ? state.comments.map(c => `<article class="message ${escape(c.kind)}"><div class="avatar ${escape(c.actor)}">${letters[c.actor]}</div><div class="message-body"><div class="message-meta"><strong>${escape(labels[c.actor])}</strong><small>${escape(new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small></div><span class="kind">${escape(c.kind.replaceAll('-', ' '))}${c.kind.startsWith('model-') ? ' · recorded session' : ''}</span><p>${escape(c.text)}</p>${c.kind === 'model-review' ? `<p><em>Static model review; execution evidence is recorded separately.</em></p>` : ''}</div></article>`).join('') : '<div class="empty"><strong>One place to pick up the thread.</strong>Run the reproduction to begin. Ownership, coordination and review will appear here.</div>';
  $('#comment-form button').disabled = busy;
}
refresh().catch(error => { $('#error').hidden = false; $('#error').textContent = error.message; });
