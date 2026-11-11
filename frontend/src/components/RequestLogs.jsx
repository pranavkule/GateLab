import React, { useEffect, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import { socket } from '../services/socket';

function statusClass(status) {
  if (status === 401) return 'badge-orange';
  if (status >= 500 || status === 0) return 'badge-red';
  return 'badge-green';
}

const PAGE_SIZE = 12;

/**
 * Request log table. Live rows arrive over Socket.IO; older/filtered rows
 * are fetched from MongoDB via the control plane.
 */
export default function RequestLogs({ newLogs, notify }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const pending = [];

  async function load() {
    try {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (search) params.set('search', search);
      if (filter !== 'all') params.set('status', filter);
      const res = await api.getLogs(params.toString());
      setRows(res.logs);
      setTotal(res.total);
    } catch (_) { /* backend restarting */ }
  }

  useEffect(() => { load(); }, [page, search, filter]);

  useEffect(() => {
    const onLog = (docs) => {
      if (docs && docs.length) { pending.push(...docs); setRows((r) => [...pending.slice(0, PAGE_SIZE), ...r].slice(0, PAGE_SIZE)); pending.length = 0; }
    };
    const onCleared = () => { setRows([]); setTotal(0); };
    socket.on('request-log', onLog);
    socket.on('logs-cleared', onCleared);
    return () => { socket.off('request-log', onLog); socket.off('logs-cleared', onCleared); };
  }, []);

  async function clearAll() {
    await api.clearLogs();
    notify('Request logs cleared', 'info');
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Request Logs</h2>
        <div className="log-controls">
          <div className="search-box">
            <Search size={14} />
            <input placeholder="Search path, method, gateway..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
            <option value="all">All statuses</option>
            <option value="success">2xx Success</option>
            <option value="unauthorized">401 Unauthorized</option>
            <option value="failed">5xx Failed</option>
          </select>
          <button className="btn btn-sm btn-outline-red" onClick={clearAll}><Trash2 size={13} /> Clear</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th><th>Method</th><th>Endpoint</th><th>Gateway</th>
              <th>Service</th><th>Instance</th><th>JWT</th><th>Status</th><th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="empty">No requests yet - send traffic from the Traffic Generator.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r._id}>
                <td className="mono">{new Date(r.timestamp).toLocaleTimeString()}</td>
                <td className="mono">{r.method}</td>
                <td className="mono">{r.path}</td>
                <td>{r.gateway}</td>
                <td>{r.backendService}</td>
                <td className="mono">{r.backendInstance}</td>
                <td><span className={`badge ${r.jwtStatus === 'valid' ? 'badge-green' : r.jwtStatus === 'none' ? 'badge-gray' : 'badge-orange'}`}>{r.jwtStatus}</span></td>
                <td><span className={`badge ${statusClass(r.status)}`}>{r.status}</span></td>
                <td className="mono">{r.latencyMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span className="muted">{total} records</span>
        <div className="pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
          <span>Page {page} / {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </div>
    </section>
  );
}
