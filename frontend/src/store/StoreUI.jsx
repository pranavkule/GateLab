import React from 'react';

export function formatPrice(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

export function PageHeading({ eyebrow, title, description, children }) {
  return (
    <div className="store-page-heading">
      <div>
        {eyebrow && <div className="store-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function Feedback({ error, success }) {
  if (!error && !success) return null;
  return (
    <div className={`store-feedback ${error ? 'is-error' : 'is-success'}`} role={error ? 'alert' : 'status'}>
      {error || success}
    </div>
  );
}

export function Loading({ label = 'Loading...' }) {
  return <div className="store-empty" role="status">{label}</div>;
}
