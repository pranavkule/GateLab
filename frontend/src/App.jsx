import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import LabPage from './pages/LabPage';
import ConfigPage from './pages/ConfigPage';
import GuidePage from './pages/GuidePage';

export default function App() {
  return (
    <div className="app">
      <Navbar />
      <div className="app-body">
        <Routes>
          <Route path="/" element={<LabPage />} />
          <Route path="/configuration" element={<ConfigPage />} />
          <Route path="/guide" element={<GuidePage />} />
        </Routes>
      </div>
    </div>
  );
}
