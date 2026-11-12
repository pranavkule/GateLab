import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import './store.css';
import { useStore } from './StoreContext';
import StoreLayout from './StoreLayout';

export function Protected({ admin = false, children }) {
  const { user } = useStore();
  const location = useLocation();
  if (!user) return <Navigate to="/store/login" replace state={{ from: location }} />;
  if (admin && user.role !== 'admin') {
    return (
      <section className="store-panel store-message">
        <h1>Administrator access required</h1>
        <p>This page is available only to an administrator account.</p>
        <Link className="store-button store-button-primary" to="/store">Return to the store</Link>
      </section>
    );
  }
  return children;
}

export default function StorefrontApp() {
  return <StoreLayout />;
}
