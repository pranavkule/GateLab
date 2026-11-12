import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Activity, BookOpen, RotateCcw, Settings } from 'lucide-react';
import { api } from '../services/api';

export default function Navbar({ onReset }) {
  const navigate = useNavigate();

  async function resetLab() {
    try {
      const res = await api.resetLab();
      if (onReset) onReset();
      alert(res.message || 'Lab reset');
    } catch (e) {
      alert('Reset failed: ' + e.message);
    }
  }

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Activity size={20} className="brand-icon" />
        <div>
          <div className="brand-name">GateLab</div>
          <div className="brand-sub">Dynamic L7 API Gateway &amp; Reverse Proxy Simulator</div>
        </div>
      </div>
      <div className="navbar-links">
        <NavLink to="/" end>Virtual Lab</NavLink>
        <NavLink to="/configuration">Configuration</NavLink>
        <NavLink to="/guide">Guide</NavLink>
        <button className="btn btn-outline-light" onClick={resetLab}>
          <RotateCcw size={14} /> Reset Lab
        </button>
      </div>
    </nav>
  );
}
