import React, { useEffect, useRef, useState } from 'react';
import type { AgentJob, Graph, Project, SpecificationDiff } from '../../shared/model';
import * as api from '../api';

interface Props {
  project: Project;
  analysisRevision?: string;
  apiBaseUrl?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onChecksChanged: (project: Project) => void;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function GraphComparison({ intended, candidate }: { intended: Graph; candidate: Graph }) {
  const key = (node: Graph['nodes'][number]) => `${node.kind}:${node.name}`;
  const intendedKeys = new Set(intended.nodes.map(key));
  const candidateKeys = new Set(candidate.nodes.map(key));
  return <div className="agent-graph-comparison">
    <p>Intent: {intended.nodes.length} items, {intended.edges.length} relationships. Candidate: {candidate.nodes.length} items, {candidate.edges.length} relationships.</p>
    <p className="text-muted">Names compare structural coverage; they do not prove runtime behavior or intent.</p>
    <div className="agent-columns">
      <div><h4>Intended architecture</h4><ul>{intended.nodes.map(node => <li key={node.id}>{node.name} <span className="text-muted">({node.kind}){!candidateKeys.has(key(node)) ? ' — intent-only' : ''}</span></li>)}</ul></div>
      <div><h4>Candidate architecture</h4><ul>{candidate.nodes.map(node => <li key={node.id}>{node.name} <span className="text-muted">({node.kind}){!intendedKeys.has(key(node)) ? ' — candidate-only' : ''}</span></li>)}</ul></div>
    </div>
  </div>;
}

function ArchitectureDiff({ title, diff }: { title: string; diff: SpecificationDiff }) {
  return <details open><summary>{title} · {diff.summary.totalChanges} changes</summary>
    <p>{diff.summary.additions} additions, {diff.summary.modifications} modifications, {diff.summary.deletions} deletions.</p>
    {diff.nodes.map(node => <details key={node.nodeId} className={node.isSensitive ? 'agent-sensitive' : ''}><summary>{node.action}: {node.name} ({node.kind}){node.isSensitive ? ' · Sensitive' : ''}{node.isProtected ? ' · Protected' : ''}</summary><p>{node.explanation}</p>{node.changes.map((change, index) => <p key={index}>{change.property}: {change.before ?? '(none)'} → {change.after ?? '(none)'}</p>)}</details>)}
    {diff.edges.map(edge => <p key={edge.edgeId}>{edge.action}: {edge.sourceNodeName} → {edge.targetNodeName} ({edge.kind}). {edge.explanation}</p>)}
    {diff.requirements.map(requirement => <p key={requirement.requirementId}>{requirement.action}: {requirement.text}. {requirement.explanation}</p>)}
  </details>;
}

export function AgentWorkspace({ project, analysisRevision, apiBaseUrl, onClose, onChanged, onChecksChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capabilities, setCapabilities] = useState<api.AgentCapabilities | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [scopeText, setScopeText] = useState('.');
  const [kind, setKind] = useState<'implementation' | 'design'>('implementation');
  const [provider, setProvider] = useState<api.AgentTaskRequest['settings']['provider']>('hosted');
  const [model, setModel] = useState('');
  const [timeout, setTimeoutMinutes] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checksText, setChecksText] = useState(JSON.stringify(project.checks, null, 2));
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [invalidatedChecks, setInvalidatedChecks] = useState<string[]>([]);
  const selected = jobs.find(job => job.id === selectedId);
  const scope = scopeText.split('\n').map(path => path.trim()).filter(Boolean);
  const validTask = !!task.trim() && scope.length > 0;
  const active = jobs.some(job => job.status === 'preparing' || job.status === 'running');
  const stale = !!selected && (selected.specRevision !== project.specRevision || (!!selected.sourceRevision && !!analysisRevision && selected.sourceRevision !== analysisRevision));
  const candidate = selected?.report?.candidate || selected?.preview;
  const sensitiveNodes = project.specification.nodes.filter(node => node.policy === 'sensitive');
  const requiredChecks = [...new Set(project.specification.nodes.flatMap(node => node.requiredChecks))];
  const needsCheckValidation = !!selected && invalidatedChecks.includes(selected.id);
  const reportSignature = JSON.stringify([selected?.report?.passed, selected?.report?.candidateHashes, selected?.report?.candidateModes, selected?.report?.issues, selected?.report?.checks]);

  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const list = await api.getJobs(project.id, apiBaseUrl);
        if (!stopped) {
          setJobs(list);
          setSelectedId(current => current || list[0]?.id || null);
        }
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    void api.getAgentCapabilities(apiBaseUrl).then(value => { if (!stopped) setCapabilities(value); }).catch(err => { if (!stopped) setError(err.message); });
    void api.getRecovery(project.id, false, apiBaseUrl).then(value => { if (!stopped) setRecovery(value.conflicts); }).catch(err => { if (!stopped) setError(err.message); });
    return () => { stopped = true; clearTimeout(timer); };
  }, [project.id, apiBaseUrl]);

  useEffect(() => { setConfirmed(false); }, [selectedId, reportSignature, stale]);

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try { await action(); } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function updateJob(job: AgentJob) {
    setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
    setSelectedId(job.id);
    setConfirmed(false);
  }

  async function decide(action: 'cancel' | 'apply' | 'revalidate') {
    if (!selected) return;
    await updateJob(await api.decideJob(project.id, selected.id, action, apiBaseUrl));
    if (action === 'revalidate') setInvalidatedChecks(current => current.filter(id => id !== selected.id));
    if (action === 'apply') await onChanged();
    if (action === 'cancel' && selected.kind === 'design') await onChanged();
  }

  async function saveChecks() {
    const checks: unknown = JSON.parse(checksText);
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('Checks must be a JSON object keyed by check ID.');
    for (const [id, value] of Object.entries(checks)) {
      const check = value as { command?: unknown; args?: unknown } | null;
      if (!id.trim() || !check || typeof check !== 'object' || typeof check.command !== 'string' || !check.command.trim() || !Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string')) {
        throw new Error(`Check ${id || '(blank)'} needs a command string and args array of strings.`);
      }
    }
    onChecksChanged(await api.updateChecks(project.id, checks as Project['checks'], apiBaseUrl));
    setNotice('Check definitions saved. Revalidate existing candidates before application.');
    setConfirmed(false);
    setInvalidatedChecks(jobs.filter(job => job.status === 'review').map(job => job.id));
  }

  return <dialog ref={dialog} className="agent-workspace" aria-labelledby="agent-title" onCancel={onClose}>
    <div className="agent-heading"><div><h2 id="agent-title">Agent workspace</h2><p>{project.name} · specification revision {project.specRevision}</p></div><button type="button" className="btn btn-secondary" onClick={onClose} autoFocus>Close</button></div>
    {error && <div className="arch-banner banner-error" role="alert">{error}</div>}
    {notice && <div className="arch-banner banner-success" role="status">{notice}</div>}
    {busy && <p role="status">{busy}…</p>}
    <section className="agent-section"><h3>Task and handoff</h3>
      <form className="arch-form" onSubmit={event => { event.preventDefault(); void run('Starting isolated task', async () => { await updateJob(await api.createJob(project.id, { task: task.trim(), scope, kind, settings: { provider, ...(model.trim() ? { model: model.trim() } : {}), timeoutMinutes: timeout } }, apiBaseUrl)); }); }}>
        <div className="form-group"><label htmlFor="agent-task">Task instructions</label><textarea className="form-input form-textarea" id="agent-task" value={task} onChange={event => setTask(event.target.value)} required maxLength={30000} rows={3} /></div>
        <div className="agent-columns">
          <div className="form-group"><label htmlFor="agent-scope">Allowed paths (one per line; . means whole project)</label><textarea className="form-input form-textarea" id="agent-scope" value={scopeText} onChange={event => setScopeText(event.target.value)} required rows={3} /></div>
          <div className="form-group"><label htmlFor="agent-kind">Task kind</label><select className="form-input" id="agent-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="implementation">Implementation candidate</option><option value="design">Architecture proposal</option></select></div>
        </div>
        <div className="agent-columns">
          <div className="form-group"><label htmlFor="agent-provider">Model provider</label><select className="form-input" id="agent-provider" value={provider} onChange={event => setProvider(event.target.value as typeof provider)}><option value="hosted">Hosted Codex</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option></select></div>
          <div className="form-group"><label htmlFor="agent-model">Model {provider !== 'hosted' ? '(required)' : '(optional)'}</label><input className="form-input" id="agent-model" value={model} onChange={event => setModel(event.target.value)} required={provider !== 'hosted'} maxLength={2000} placeholder={provider === 'hosted' ? 'CLI default model' : 'Installed local model name'} /></div>
          <div className="form-group"><label htmlFor="agent-timeout">Timeout (minutes)</label><input className="form-input" id="agent-timeout" type="number" min={1} max={120} required value={timeout} onChange={event => setTimeoutMinutes(Number(event.target.value))} /></div>
        </div>
        <p role="status">{!capabilities ? 'Checking integrated execution availability…' : capabilities.available ? 'Isolated execution available. Hosted runs use your configured account.' : `Integrated execution unavailable: ${capabilities.reason || 'The isolation boundary is unavailable'}. Download a package and import external results below.`}</p>
        <div className="agent-actions">
          <button className="btn btn-primary" type="submit" disabled={!!busy || active || !validTask || !capabilities?.available || !capabilities.providers.includes(provider) || (provider !== 'hosted' && !model.trim())}>Start isolated task</button>
          <button className="btn btn-secondary" type="button" disabled={!!busy || !validTask} onClick={() => void run('Downloading package', async () => { download(await api.exportPackage(project.id, task.trim(), scope, apiBaseUrl), `${project.id}-handoff.zip`); })}>Download handoff package</button>
          <button className="btn btn-secondary" type="button" disabled={!!busy || !validTask} onClick={() => void run('Preparing result template', async () => {
            const handoff = await api.getHandoff(project.id, task.trim(), scope, apiBaseUrl);
            const result: api.ResultEnvelope = { schemaVersion: 1, handoffId: handoff.handoffId, projectId: project.id, specRevision: handoff.specRevision, sourceHashes: handoff.sourceHashes, task: task.trim(), scope, files: {} };
            download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), `${project.id}-result-template.json`);
          })}>Download result JSON template</button>
        </div>
      </form>
      <p className="text-muted">External result JSON: keep the template handoff ID, baseline hashes and revision, put changed UTF-8 file contents in files, and use null for deletions. Import creates a review candidate.</p>
      <div className="form-group"><label htmlFor="agent-result">Import external result JSON</label><input className="form-input" id="agent-result" type="file" accept=".json,application/json" disabled={!!busy || active} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void run('Importing candidate', async () => { await updateJob(await api.importResult(project.id, JSON.parse(await file.text()), apiBaseUrl)); });
      }} /></div>
    </section>
    <details className="agent-section"><summary>Required check definitions</summary>
      <p>Required by intent: {requiredChecks.length ? requiredChecks.join(', ') : 'none'}. References are set in the Protection editor. Commands run in the candidate workspace.</p>
      <label htmlFor="agent-checks">JSON object: {'{"typecheck":{"command":"npm","args":["run","typecheck"]}}'}</label>
      <textarea className="form-input form-textarea agent-code" id="agent-checks" rows={7} value={checksText} onChange={event => setChecksText(event.target.value)} spellCheck={false} />
      <button type="button" className="btn btn-secondary" disabled={!!busy || active} onClick={() => void run('Saving checks', saveChecks)}>Save check definitions</button>
    </details>
    {recovery && recovery.length > 0 && <section className="agent-section"><h3>Interrupted application needs recovery</h3><ul>{recovery.map(path => <li key={path}>{path}</li>)}</ul><p>These files changed after the interrupted write. Recovery preserves conflicting files.</p><button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void run('Retrying recovery', async () => { const result = await api.getRecovery(project.id, true, apiBaseUrl); setRecovery(result.conflicts); if (!result.conflicts.length) { setNotice('Recovery completed.'); await onChanged(); } })}>Retry safe recovery</button></section>}
    <section className="agent-section"><h3>Jobs and candidate review</h3>
      {!jobs.length && <p>No jobs yet. Start a task or import a result.</p>}
      <div className="agent-jobs" aria-label="Project jobs">{jobs.map(job => <button type="button" key={job.id} className={`btn btn-secondary ${selectedId === job.id ? 'agent-job-selected' : ''}`} aria-pressed={selectedId === job.id} onClick={() => setSelectedId(job.id)}>{job.task.slice(0, 70)} · {job.kind} · {job.status}</button>)}</div>
      {selected && <div>
        <h4>{selected.task}</h4><p>Status: {selected.status} · base specification {selected.specRevision} · scope: {selected.scope.join(', ')}</p>
        {selected.settings && <p>Provider: {selected.settings.provider} · model: {selected.settings.model || 'CLI default'} · timeout: {selected.settings.timeoutMinutes} minutes</p>}
        {selected.error && <p role="alert">{selected.error}</p>}
        {stale && <p className="arch-banner banner-error" role="alert">This candidate is stale because the specification or source revision changed. Import a fresh result or start a new task.</p>}
        {(selected.status === 'preparing' || selected.status === 'running') && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void run('Cancelling task', () => decide('cancel'))}>Cancel task</button>}
        <details><summary>Structured progress ({selected.events.length} events)</summary><ol className="agent-progress">{selected.events.map((event, index) => <li key={`${event.time}-${index}`}><time>{event.time}</time>{event.type && <span> · {event.type}</span>}{event.stream && <span> · {event.stream}</span>}<pre>{event.message}</pre></li>)}</ol></details>
        {candidate && <details open><summary>Candidate preview · {candidate.status}</summary><GraphComparison intended={project.specification} candidate={candidate.graph} />{candidate.quality.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.severity}: {diagnostic.path}{diagnostic.line ? `:${diagnostic.line}` : ''} {diagnostic.message}</p>)}</details>}
        {selected.proposal && <details open><summary>Proposed intended architecture</summary><p>{selected.proposal.explanation}</p><GraphComparison intended={project.specification} candidate={selected.proposal.graph} />{selected.proposal.questions.map((question, index) => <p key={index}>{question}</p>)}<p>Review and accept this proposal in the workspace Review panel.</p></details>}
        {selected.report && <div className="agent-report">
          <h4>Validation: {selected.report.passed ? 'passed — human review required' : 'blocked'}</h4>
          {needsCheckValidation && <p role="alert">Check definitions changed. Revalidate this candidate before applying.</p>}
          {selected.report.issues.map((issue, index) => <p key={index} role="alert">{issue.code}: {issue.path && `${issue.path}: `}{issue.message}</p>)}
          {selected.report.warnings.map((warning, index) => <p key={index}>Warning: {warning}</p>)}
          {selected.report.architectureDiff && <><ArchitectureDiff title="Architecture changes from implemented source" diff={selected.report.architectureDiff.implemented} /><ArchitectureDiff title="Architecture differences from intended specification" diff={selected.report.architectureDiff.intended} /></>}
          <h4>Check results</h4>{Object.entries(selected.report.checks).length === 0 && <p>No command check results.</p>}
          {Object.entries(selected.report.checks).map(([id, result]) => <details key={id}><summary>{id}: {result.passed ? 'passed' : 'failed'}</summary><pre>{result.output}</pre></details>)}
          <h4>Actual file changes ({selected.report.changes.length})</h4>
          {selected.report.changes.map(change => {
            const sensitive = sensitiveNodes.filter(node => node.source?.path === change.path);
            return <details key={change.path} className={sensitive.length ? 'agent-sensitive' : ''} open={sensitive.length > 0}>
              <summary>{change.kind}: {change.path}{sensitive.length ? ` · Sensitive: ${sensitive.map(node => node.name).join(', ')}` : ''}</summary>
              {change.beforeMode !== change.afterMode && <p>File permissions: {change.beforeMode == null ? '(absent)' : change.beforeMode.toString(8)} → {change.afterMode == null ? '(absent)' : change.afterMode.toString(8)}</p>}
              {sensitive.map(node => <p key={node.id}>Sensitive review instructions: {node.instructions || 'Review this protected area carefully.'}</p>)}
              <pre className="agent-code" aria-label={`Diff for ${change.path}`}>{change.diff || 'No textual diff available.'}</pre>
              <details><summary>Full before and after</summary><div className="agent-columns"><div><h5>Before</h5><pre>{change.before ?? '(new file)'}</pre></div><div><h5>After</h5><pre>{change.after ?? '(deleted file)'}</pre></div></div></details>
            </details>;
          })}
          {selected.status === 'review' && selected.kind !== 'design' && <div>
            <label className="agent-confirm"><input type="checkbox" checked={confirmed} disabled={!!busy || stale || needsCheckValidation || !selected.report.passed} onChange={event => setConfirmed(event.target.checked)} /> I reviewed the file changes, sensitive areas, architecture diagnostics, and check results.</label>
            <div className="agent-actions"><button type="button" className="btn btn-primary" disabled={!!busy || !confirmed || !selected.report.passed || stale || needsCheckValidation || recovery === null || recovery.length > 0} onClick={() => void run('Applying reviewed candidate', () => decide('apply'))}>Apply reviewed files</button><button type="button" className="btn btn-secondary" disabled={!!busy || stale} onClick={() => void run('Revalidating candidate', () => decide('revalidate'))}>Revalidate candidate</button><button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void run('Rejecting candidate', () => decide('cancel'))}>Reject candidate</button></div>
            <p className="text-muted">Application rechecks revisions, source hashes, and policies on the service immediately before writing.</p>
          </div>}
        </div>}
      </div>}
    </section>
  </dialog>;
}
