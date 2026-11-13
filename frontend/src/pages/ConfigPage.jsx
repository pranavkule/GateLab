import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Save, X, History, KeyRound, Server, Layers } from 'lucide-react';
import { api } from '../services/api';
import { useLab } from '../hooks/useLab';
import { ENTRY_LB_PORT, GATEWAY_PORTS, BACKEND_INSTANCES } from '../services/ports';

const TARGETS = ['users', 'products', 'orders'];

function emptyRule() {
  return { id: `r-${Date.now()}`, path: '/api/', targetService: 'users', authRequired: false, enabled: true, rateLimit: null };
}

function rateLimitLabel(rateLimit) {
  if (!rateLimit || !(rateLimit.limit > 0)) return 'Unlimited';
  return `${rateLimit.limit} / ${Math.max(1, Math.round((rateLimit.windowMs || 15000) / 1000))}s`;
}

export default function ConfigPage() {
  const lab = useLab();
  const [config, setConfig] = useState(null); // working copy being edited
  const [version, setVersion] = useState(0);
  const [lastReload, setLastReload] = useState(null);
  const [history, setHistory] = useState(null);
  const [editing, setEditing] = useState(null); // rule id being edited
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);

  async function load() {
    const cfg = await api.getLatestConfig();
    setConfig(cfg.routes);
    setVersion(cfg.version);
    setLastReload(cfg.appliedAt);
    setHistory(await api.getConfigHistory());
    setStatus(await api.getStatus());
  }
  useEffect(() => { load().catch((e) => lab.notify('Load failed: ' + e.message, 'error')); }, []);

  function setRuleField(id, field, value) {
    setConfig((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addRule() {
    const rule = emptyRule();
    setConfig((rs) => [...rs, rule]);
    setEditing(rule.id);
    setDraft(rule);
  }

  function startEdit(rule) {
    // Draft carries rate-limit fields as editable strings; normalized on save.
    const rl = rule.rateLimit || {};
    setEditing(rule.id);
    setDraft({
      ...rule,
      _rlLimit: rl.limit != null ? String(rl.limit) : '',
      _rlWindow: rl.windowMs != null ? String(Math.round(rl.windowMs / 1000)) : '15',
    });
  }
  function cancelEdit(id) {
    setEditing(null);
    if (draft && !config.find((r) => r.id === draft.id && r === draft)) {
      // discard new unsaved rule rows
      setConfig((rs) => rs.filter((r) => r.id !== id || r.path !== '/api/'));
    }
    setDraft(null);
  }
  function saveEdit() {
    // Normalize the rate-limit draft: a positive integer limit + window in
    // seconds becomes { limit, windowMs }; an empty limit means unlimited.
    const limit = parseInt(draft._rlLimit, 10);
    const windowSec = parseInt(draft._rlWindow, 10);
    const rateLimit = Number.isFinite(limit) && limit >= 1
      ? { limit, windowMs: (Number.isFinite(windowSec) && windowSec >= 1 ? windowSec : 15) * 1000 }
      : null;
    const rule = { ...draft, rateLimit };
    delete rule._rlLimit;
    delete rule._rlWindow;
    setConfig((rs) => rs.map((r) => (r.id === draft.id ? rule : r)));
    setEditing(null);
    setDraft(null);
  }
  function deleteRule(id) {
    setConfig((rs) => rs.filter((r) => r.id !== id));
  }

  async function apply() {
    setError('');
    try {
      const applied = await api.applyConfig(config);
      setVersion(applied.version);
      setConfig(applied.routes);
      setLastReload(new Date().toISOString());
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="config-page">
      <section className="card">
        <div className="card-head">
          <h2><Layers size={18} /> Dynamic Routing Configuration</h2>
          <div className="config-meta">
            <span className="badge badge-blue">Active version: v{version}</span>
            <span className="muted tiny">Last reload: {lastReload ? new Date(lastReload).toLocaleString() : '-'}</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="log-table">
            <thead>
              <tr><th>Path</th><th>Target Service</th><th>Auth Required</th><th>Rate Limit</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {(config || []).map((r) => (
                <tr key={r.id}>
                  {editing === r.id ? (
                    <>
                      <td><input className="inline-input" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} /></td>
                      <td>
                        <select className="inline-input" value={draft.targetService} onChange={(e) => setDraft({ ...draft, targetService: e.target.value })}>
                          {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="inline-input" value={draft.authRequired ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, authRequired: e.target.value === 'yes' })}>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </td>
                      <td>
                        <div className="field-row" style={{ gap: 4 }}>
                          <input
                            className="inline-input" style={{ width: 64 }} type="number" min="1" placeholder="∞"
                            title="Limit: positive integer, empty = unlimited"
                            value={draft._rlLimit} onChange={(e) => setDraft({ ...draft, _rlLimit: e.target.value })}
                          />
                          <input
                            className="inline-input" style={{ width: 64 }} type="number" min="1"
                            title="Window in seconds (1000-3600000 ms)"
                            value={draft._rlWindow} onChange={(e) => setDraft({ ...draft, _rlWindow: e.target.value })}
                          />
                        </div>
                      </td>
                      <td>
                        <select className="inline-input" value={draft.enabled === false ? 'no' : 'yes'} onChange={(e) => setDraft({ ...draft, enabled: e.target.value === 'yes' })}>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </td>
                      <td className="row-actions">
                        <button className="btn btn-sm btn-primary" onClick={saveEdit}><Save size={13} /> Save</button>
                        <button className="btn btn-sm" onClick={() => cancelEdit(r.id)}><X size={13} /> Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="mono">{r.path}</td>
                      <td>{r.targetService}</td>
                      <td><span className={`badge ${r.authRequired ? 'badge-orange' : 'badge-gray'}`}>{r.authRequired ? 'Yes' : 'No'}</span></td>
                      <td><span className={`badge ${r.rateLimit && r.rateLimit.limit > 0 ? 'badge-blue' : 'badge-gray'}`}>{rateLimitLabel(r.rateLimit)}</span></td>
                      <td><span className={`badge ${r.enabled === false ? 'badge-red' : 'badge-green'}`}>{r.enabled === false ? 'Disabled' : 'Enabled'}</span></td>
                      <td className="row-actions">
                        <button className="btn btn-sm" onClick={() => startEdit(r)}><Pencil size={13} /> Edit</button>
                        <button className="btn btn-sm btn-outline-red" onClick={() => deleteRule(r.id)}><Trash2 size={13} /></button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <div className="banner banner-red">{error}</div>}
        <div className="config-actions">
          <button className="btn btn-outline-blue" onClick={addRule}><Plus size={14} /> Add Rule</button>
          <button className="btn btn-primary" onClick={apply}><Save size={14} /> Apply Configuration</button>
          <span className="muted tiny">Apply validates, persists to MongoDB (version++), and syncs all 3 gateways live via Redis Pub/Sub - no restart. Rate limit = max requests / window seconds; empty limit = unlimited (shared Redis counter across all gateways).</span>
        </div>
      </section>

      <div className="config-grid">
        <section className="card">
          <div className="card-head"><h2><KeyRound size={17} /> JWT Settings</h2></div>
          <div className="kv">
            <div><span>Algorithm</span><b>HS256</b></div>
            <div><span>Claims</span><b>sub (user), role, iat, exp</b></div>
            <div><span>Expiry</span><b>1 hour</b></div>
            <div><span>Secret storage</span><b>Server-side environment variable only - never exposed to the frontend</b></div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2><Server size={17} /> Runtime Topology</h2></div>
          <div className="kv">
            <div><span>Entry load balancer</span><b>:{ENTRY_LB_PORT} (round-robin, healthy gateways only)</b></div>
            <div><span>Gateway instances</span><b>{GATEWAY_PORTS.map((p) => `:${p}`).join(' ')}</b></div>
            {Object.keys(BACKEND_INSTANCES).map((key) => (
              <div key={key}><span>{key.charAt(0).toUpperCase() + key.slice(1)} Service</span><b>{BACKEND_INSTANCES[key].map((p) => `:${p}`).join(' ')}</b></div>
            ))}
            <div><span>Control plane</span><b>:{import.meta.env.VITE_CONTROL_PLANE_PORT || 5010} (REST + Socket.IO)</b></div>
            <div><span>Auth service</span><b>:{import.meta.env.VITE_AUTH_PORT || 5011}</b></div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2><History size={17} /> Configuration History &amp; Audit</h2></div>
        <div className="table-wrap">
          <table className="log-table">
            <thead><tr><th>Version</th><th>Action</th><th>Changed by</th><th>Summary</th><th>When</th></tr></thead>
            <tbody>
              {(history?.audit || []).map((a, i) => (
                <tr key={i}>
                  <td className="mono">v{a.version}</td>
                  <td><span className={`badge ${a.action === 'seed' ? 'badge-gray' : 'badge-blue'}`}>{a.action}</span></td>
                  <td>{a.changedBy}</td>
                  <td>{a.summary}</td>
                  <td className="mono">{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {(!history || (history.audit || []).length === 0) && (
                <tr><td colSpan={5} className="empty">No configuration changes yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {lab.toast && <div className={`toast toast-${lab.toast.kind}`}>{lab.toast.message}</div>}
    </div>
  );
}
