import { useEffect, useRef, useState } from 'react';
import { socket } from '../services/socket';
import { api } from '../services/api';
import { useStore } from '../store/StoreContext';

const EMPTY_OVERVIEW = { totalRequests: 0, success: 0, unauthorized: 0, rateLimited: 0, failed: 0, avgLatency: 0, throughputRps: 0 };

/**
 * Central live-lab state hook: REST bootstrap + Socket.IO streams.
 * Every number shown in the UI comes from these real backend events.
 */
export function useLab() {
  const { token } = useStore();
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
    if (!token) {
      socket.disconnect();
      setConnected(false);
      return undefined;
    }

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onMetrics = (m) => {
      if (m.overview) setOverview(m.overview);
      if (m.history) setHistory(m.history);
      if (m.gateways) setGatewayMetrics(m.gateways);
      if (m.backends) setBackendMetrics(m.backends);
    };
    const onGatewayHealth = (snap) => setGatewayHealth({ ...snap });
    const onBackendHealth = (snap) => setBackendHealth({ ...snap });
    const onRequestLog = (docs) => setNewLogs(docs);
    const onConfigUpdate = (cfg) => {
      setConfigVersion(cfg.version);
      notify(`Configuration applied - version ${cfg.version} synced to all gateways`, 'success');
    };

    socket.auth = { token };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('metrics', onMetrics);
    socket.on('gateway-health', onGatewayHealth);
    socket.on('backend-health', onBackendHealth);
    socket.on('request-log', onRequestLog);
    socket.on('config-update', onConfigUpdate);
    socket.connect();
    api.getStatus().then((s) => {
      setStatus(s);
      setConfigVersion(s.configVersion);
    }).catch(() => notify('Control plane unreachable - is the backend running?', 'error'));

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('metrics', onMetrics);
      socket.off('gateway-health', onGatewayHealth);
      socket.off('backend-health', onBackendHealth);
      socket.off('request-log', onRequestLog);
      socket.off('config-update', onConfigUpdate);
      socket.disconnect();
    };
  }, [token]);

  return {
    connected, overview, history, gatewayMetrics, backendMetrics,
    gatewayHealth, backendHealth, status, configVersion, newLogs, toast, notify,
  };
}
