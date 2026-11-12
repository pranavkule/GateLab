import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Activity, CheckCircle2, XCircle, ShieldAlert, Timer, Gauge } from 'lucide-react';

export default function SystemOverview({ overview, history, connected }) {
  const items = [
    { label: 'Total Requests', value: overview.totalRequests, icon: Activity, color: 'blue' },
    { label: 'Successful', value: overview.success, icon: CheckCircle2, color: 'green' },
    { label: 'Unauthorized', value: overview.unauthorized, icon: ShieldAlert, color: 'orange' },
    { label: 'Failed', value: overview.failed, icon: XCircle, color: 'red' },
    { label: 'Avg Latency', value: `${overview.avgLatency} ms`, icon: Timer, color: 'blue' },
    { label: 'Throughput', value: `${overview.throughputRps}/s`, icon: Gauge, color: 'blue' },
  ];
  // Real 1 s snapshots from the entry load balancer (ts, requests-per-second).
  const chartData = (history || []).map((h) => ({ ts: h.ts, rps: h.rps }));
  const timeLabel = (ts) => new Date(ts).toLocaleTimeString();

  return (
    <section className="card">
      <div className="card-head">
        <h2>System Overview</h2>
        <span className={`live-badge ${connected ? 'on' : 'off'}`}>{connected ? 'Live' : 'Offline'}</span>
      </div>
      <div className="overview-grid">
        {items.map((it) => (
          <div key={it.label} className="stat">
            <div className="stat-icon"><it.icon size={16} /></div>
            <div>
              <div className="stat-value">{it.value}</div>
              <div className="stat-label">{it.label}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="gRps" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5effb" />
            <XAxis dataKey="ts" tickFormatter={timeLabel} tick={{ fontSize: 10, fill: '#64748b' }} />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ fontSize: 12 }}
              labelFormatter={(ts) => timeLabel(ts)}
              formatter={(v) => [`${v} req/s`, 'Throughput']}
            />
            <Area type="monotone" dataKey="rps" stroke="#2563eb" fill="url(#gRps)" strokeWidth={2} name="Throughput" unit=" req/s" />
          </AreaChart>
        </ResponsiveContainer>
        <div className="chart-caption">Throughput (requests per second, last 60 s)</div>
      </div>
    </section>
  );
}
