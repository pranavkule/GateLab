import { useEffect, useRef, useState } from 'react';
import { socket } from '../services/socket';
import { api } from '../services/api';

const EMPTY_OVERVIEW = { totalRequests: 0, success: 0, unauthorized: 0, failed: 0, avgLatency: 0, throughputRps: 0 };

/**
 * Central live-lab state hook: REST bootstrap + Socket.IO streams.
 * Every number shown in the UI comes from these real backend events.
 */
export function useLab() {
  const [connected, setConnected] = useState(socket.connected);
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [history, setHistory] = useState([]);
  const [gatewayMetrics, setGatewayMetrics] = useState([]);
  const [backendMetrics, setBackendMetrics] = useState([]);
  const [gatewayHealth, setGatewayHealth] = useState({});
  const [backendHealth, setBackendHealth] = useState({});
  const [status, setStatus] = useState(null);
  const [configVersion, setConfigVersion] = useState(0);
  const [newLogs, setNewLogs] = useState([]); // pushed batches for the log table
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const notify = (message, kind = 'info') => {
    setToast({ message, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('metrics', (m) => {
      if (m.overview) setOverview(m.overview);
      if (m.history) setHistory(m.history);
      if (m.gateways) setGatewayMetrics(m.gateways);
      if (m.backends) setBackendMetrics(m.backends);
    });
    socket.on('gateway-health', (snap) => setGatewayHealth({ ...snap }));
    socket.on('backend-health', (snap) => setBackendHealth({ ...snap }));
    socket.on('request-log', (docs) => setNewLogs(docs));
    socket.on('config-update', (cfg) => {
      setConfigVersion(cfg.version);
      notify(`Configuration applied - version ${cfg.version} synced to all gateways`, 'success');
    });

    api.getStatus().then((s) => {
      setStatus(s);
      setConfigVersion(s.configVersion);
    }).catch(() => notify('Control plane unreachable - is the backend running?', 'error'));

    return () => { socket.off(); };
  }, []);

  return {
    connected, overview, history, gatewayMetrics, backendMetrics,
    gatewayHealth, backendHealth, status, configVersion, newLogs, toast, notify,
  };
}
