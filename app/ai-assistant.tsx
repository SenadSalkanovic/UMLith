'use client';

import { useI18n } from './i18n';
import { translate, errorText, type Locale } from './lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { parseAiResult, type AiAction, type AiProvider, type AiRequest, type AiResult } from './lib/ai';
import { checkDiagram, modes, parseProject, type Project } from './lib/model';
import { toAiPrompt } from './lib/plantuml';

const PENDING_KEY = 'umlith-ai-request';
type Answer = { id?: string; request: AiRequest; result?: AiResult };

async function readAnswer(response: Response, locale: Locale): Promise<Answer> {
  const t = translate.bind(null, locale);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || t('aiHttpError', { status: response.status }));
  return { ...body, request: { ...body.request, project: parseProject(body.request.project, locale) }, result: body.result ? parseAiResult(body.result, body.request.action, locale) : undefined };
}

export default function AiAssistant({ open, project, onClose, onApply, onDownload }: { open: boolean; project: Project; onClose: () => void; onApply: (base: Project, result: AiResult) => void; onDownload: (prompt: string) => void }) {
  const { locale, t } = useI18n();
  const [initialLocale] = useState(locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [provider, setProvider] = useState<AiProvider>('codex');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [exportPrompt, setExportPrompt] = useState('');
  const [mcpScript, setMcpScript] = useState('');
  const pendingId = answer?.result ? undefined : answer?.id;

  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    const abort = new AbortController();
    let id: string | null = null;
    try { id = sessionStorage.getItem(PENDING_KEY); } catch { /* MCP still works without reload recovery. */ }
    if (id) fetch(`/api/ai?id=${encodeURIComponent(id)}`, { signal: abort.signal, headers: { 'Accept-Language': initialLocale } }).then(response => readAnswer(response, initialLocale)).then(job => { setAnswer(job); setProvider('mcp'); setPrompt(job.request.prompt); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [initialLocale]);
  useEffect(() => {
    if (!open || mcpScript) return;
    const abort = new AbortController();
    fetch('/api/ai?setup=1', { signal: abort.signal, headers: { 'Accept-Language': locale } }).then(r => r.json()).then(v => { if (v.script) setMcpScript(v.script); }).catch(() => { /* README includes the same setup. */ });
    return () => abort.abort();
  }, [open, mcpScript, locale]);
  useEffect(() => {
    if (!pendingId) return;
    const id = pendingId;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await readAnswer(await fetch(`/api/ai?id=${encodeURIComponent(id)}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]), cache: 'no-store', headers: { 'Accept-Language': locale } }), locale);
        if (abort.signal.aborted) return;
        setAnswer(next); setError('');
        if (next.result) return;
      } catch (e) { if (abort.signal.aborted) return; setError(t('mcpPollFailed', { error: errorText(e, locale) })); }
      timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 1000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [pendingId, locale, t]);

  async function send(action: AiAction) {
    const instruction = prompt.trim() || project.goal.trim();
    if (!instruction) { setError(t('aiInstructionRequired')); return; }
    if (provider === 'local' && !model.trim()) { setError(t('localModelRequired')); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setExportPrompt('');
    try {
      const request: AiRequest = { action, prompt: instruction, project: parseProject(project, locale), locale };
      const next = await readAnswer(await fetch('/api/ai', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json', 'Accept-Language': locale }, body: JSON.stringify({ ...request, provider, model }) }), locale);
      setAnswer(next);
      try {
        if (next.id) sessionStorage.setItem(PENDING_KEY, next.id);
        else sessionStorage.removeItem(PENDING_KEY);
      } catch { /* The request remains available while this page is open. */ }
    } catch (e) { setError(abort.signal.aborted ? t('requestCancelled') : errorText(e, locale)); }
    finally { setBusy(false); controller.current = null; }
  }

  async function cancelMcp() {
    try {
      const response = await fetch(`/api/ai?id=${encodeURIComponent(answer!.id!)}`, { method: 'DELETE', headers: { 'Accept-Language': locale } });
      if (!response.ok) throw new Error(t('cancelMcpFailed'));
      setAnswer(null); setError('');
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* Storage can be unavailable. */ }
    } catch (e) { setError(errorText(e, locale)); }
  }
  const pending = !!answer?.id && !answer.result;
  const stale = !!answer && JSON.stringify(parseProject(project)) !== JSON.stringify(answer.request.project);
  const proposal = answer?.result?.project;
  const warnings = proposal?.diagrams.flatMap(d => d.nodes.length ? checkDiagram(d, locale).map(issue => `${t(modes[d.id])}: ${issue}`) : []) || [];

  return <dialog ref={dialog} className="prompt-dialog ai-dialog" aria-labelledby="ai-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-header"><div><h2 id="ai-title">{t('aiArchitecture')}</h2><p>{t('aiIntro')}</p></div><button className="icon-button" aria-label={t('closeAi')} onClick={onClose}>×</button></div>
    <div className="ai-content">
      <div className="ai-fields"><label>{t('provider')}<select value={provider} disabled={busy || pending} onChange={e => { setProvider(e.target.value as AiProvider); setModel(''); }}>
        <option value="codex">{t('codexCli')}</option><option value="claude">{t('claudeCli')}</option><option value="local">{t('localLlm')}</option><option value="mcp">{t('mcpClient')}</option>
      </select></label>{provider !== 'mcp' && <label>{provider === 'local' ? t('localModelName') : t('optionalModel')}<input value={model} disabled={busy} maxLength={200} onChange={e => setModel(e.target.value)} placeholder={provider === 'local' ? t('localModelPlaceholder') : t('defaultCliModel')}/></label>}</div>
      <p className="field-help">{provider === 'local' ? t('localProviderHelp') : provider === 'mcp' ? t('mcpProviderHelp') : t('cliProviderHelp')}</p>
      <label>{t('aiInstruction')}<textarea rows={4} maxLength={20000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={project.goal || t('aiInstructionPlaceholder')} disabled={busy || pending}/></label>
      <p className="field-help">{t('aiProjectHelp')}</p>
      <div className="export-actions"><button className="primary-button" disabled={busy || pending} onClick={() => send('generate')}>{t('generateArchitecture')}</button><button className="secondary-button" disabled={busy || pending} onClick={() => send('review')}>{t('reviewModel')}</button>{busy && <button className="quiet-button" onClick={() => controller.current?.abort()}>{t('cancel')}</button>}</div>
      {busy && <p role="status">{t('aiBusy')}</p>}
      {error && <p className="inline-error" role="alert">{errorText(error, locale)}</p>}
      {pending && <div className="ai-result" role="status"><h3>{t('waitingMcp')}</h3><p>{t('sendToClient')}</p><pre className="ai-command">{t('mcpCommand', { id: answer.id! })}</pre><button className="secondary-button" onClick={cancelMcp}>{t('cancelMcp')}</button></div>}
      {answer?.result && <section className="ai-result" aria-label={t('aiResponse')}>
        <h3>{proposal ? t('architectureProposal') : t('aiReview')}</h3><div className="ai-summary">{answer.result.summary}</div>
        {stale && <p className="inline-error">{t('staleAnswer')}</p>}
        {proposal && <>
          <ul>{proposal.diagrams.map(d => <li key={d.id}>{t(modes[d.id])}: {t('diagramCounts', { nodes: d.nodes.length, edges: d.edges.length })}</li>)}</ul>
          {warnings.length > 0 && <div><h4>{t('structureWarnings')}</h4><ul className="issue-list">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
          <details><summary>{t('previewJson')}</summary><pre className="ai-json">{JSON.stringify(proposal, null, 2)}</pre></details>
          <p className="field-help">{t('replaceDiagramsHelp')}</p>
          <button className="primary-button" disabled={stale || busy} onClick={() => {
            try { onApply(answer.request.project, answer.result!); onClose(); }
            catch (e) { setError(errorText(e, locale)); }
          }}>{t('applyProposal')}</button>
        </>}
      </section>}
      <details className="ai-help"><summary>{t('mcpSetup')}</summary><p>{t('mcpSetupHelp')}</p><pre className="ai-command">{JSON.stringify({ mcpServers: { umlith: { command: 'node', args: ['--experimental-strip-types', mcpScript || '/path/to/UMLith/scripts/umlith-mcp.mjs'] } } }, null, 2)}</pre><p className="field-help">{t('mcpReadHelp')}</p></details>
      <details className="ai-help"><summary>{t('manualPrompt')}</summary><button className="secondary-button" onClick={() => { try { setExportPrompt(toAiPrompt({ ...project, goal: prompt.trim() || project.goal }, locale)); setError(''); } catch (e) { setError(errorText(e, locale)); } }}>{t('preparePrompt')}</button>{exportPrompt && <><label>{t('copyText')}<textarea className="ai-json" rows={8} value={exportPrompt} onChange={e => setExportPrompt(e.target.value)} onFocus={e => e.currentTarget.select()}/></label><div className="export-actions"><button className="secondary-button" onClick={() => navigator.clipboard.writeText(exportPrompt).catch(() => setError(t('manualCopyFailed')))}>{t('copy')}</button><button className="secondary-button" onClick={() => onDownload(exportPrompt)}>{t('saveMarkdown')}</button></div></>}</details>
    </div>
  </dialog>;
}
