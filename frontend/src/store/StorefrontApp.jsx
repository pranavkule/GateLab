import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import './store.css';
import { isStudent } from '../services/roles';
import { useStore } from './StoreContext';
import StoreLayout from './StoreLayout';

export function Protected({ admin = false, children }) {
  const { user } = useStore();
  const location = useLocation();
  if (!user) return <Navigate to="/store/login" replace state={{ from: location }} />;
  if (isStudent(user)) {
    return (
      <section className="store-panel store-message">
        <h1>Customer account required</h1>
        <p>Student accounts use the Virtual Lab and cannot access the customer account area.</p>
        <Link className="store-button store-button-primary" to="/">Return to the Virtual Lab</Link>
      </section>
    );
  }
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
