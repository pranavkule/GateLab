import { io } from 'socket.io-client';
import { SOCKET_URL } from './api';

// Singleton live-update connection to the control plane.
export const socket = io(SOCKET_URL, { autoConnect: false, transports: ['websocket', 'polling'] });
