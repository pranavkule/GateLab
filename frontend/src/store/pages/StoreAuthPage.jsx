import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, LockKeyhole, ShieldCheck, ShoppingBag, UserRound } from 'lucide-react';
import { api } from '../../services/api';
import { canAccessLab, isAdmin, roleLabel } from '../../services/roles';
import { useStore } from '../StoreContext';
import { Feedback } from '../StoreUI';

function GateLabBrand({ compact = false, inverted = false }) {
  const className = ['gatelab-brand', compact ? 'gatelab-brand-compact' : '', inverted ? 'gatelab-brand-inverted' : ''].filter(Boolean).join(' ');
  return (
    <div className={className}>
      <Activity size={compact ? 20 : 24} className="brand-icon" aria-hidden="true" />
      <div>
        <div className="brand-name">GateLab</div>
        <div className="brand-sub">Dynamic L7 API Gateway &amp; Reverse Proxy Simulator</div>
      </div>
    </div>
  );
}

function GateLabAuthShell({ children }) {
  return (
    <div className="gatelab-auth-shell">
      <aside className="gatelab-auth-aside">
        <GateLabBrand />
        <div className="gatelab-auth-intro">
          <div className="store-eyebrow">GateLab access</div>
          <h1>One sign-in for the lab and the store.</h1>
          <p>The dashboard and Demo Store share one GateLab session, with each account continuing to the workspace it is meant to use.</p>
        </div>
        <ul className="gatelab-auth-points">
          <li>
            <span className="gatelab-auth-point-icon"><Activity size={17} aria-hidden="true" /></span>
            <div><strong>Gateway dashboard</strong><span>Live traffic, service health, logs and routing controls.</span></div>
          </li>
          <li>
            <span className="gatelab-auth-point-icon"><ShoppingBag size={17} aria-hidden="true" /></span>
            <div><strong>Demo Store</strong><span>Catalog, cart, checkout and order history.</span></div>
          </li>
          <li>
            <span className="gatelab-auth-point-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
            <div><strong>Role-aware access</strong><span>Administrators and students enter the lab; customers enter the store.</span></div>
          </li>
        </ul>
        <Link className="gatelab-auth-aside-link" to="/store">
          <ShoppingBag size={15} aria-hidden="true" /> Browse the Demo Store <ArrowRight size={14} aria-hidden="true" />
        </Link>
        <Activity size={360} strokeWidth={1} className="gatelab-auth-watermark" aria-hidden="true" />
      </aside>
      <main className="gatelab-auth-main">
        <div className="gatelab-auth-topbar">
          <GateLabBrand compact inverted />
          <Link className="gatelab-auth-store-link" to="/store">
            <ShoppingBag size={15} aria-hidden="true" /> Demo Store
          </Link>
        </div>
        {children}
        <p className="gatelab-auth-footnote">GateLab · Dynamic L7 API Gateway &amp; Reverse Proxy Simulator</p>
      </main>
    </div>
  );
}

function isCustomerStoreDestination(pathname) {
  if (!pathname) return false;
  if (pathname !== '/store' && !pathname.startsWith('/store/')) return false;
  return pathname !== '/store/login'
    && pathname !== '/store/register'
    && pathname !== '/store/admin'
    && !pathname.startsWith('/store/admin/');
}

function labDestination(user, requested) {
  if (requested === '/' || requested === '/guide') return requested;
  if (isAdmin(user)) {
    if (requested === '/configuration') return requested;
    if (isCustomerStoreDestination(requested)) return requested;
  }
  return '/';
}

function loginDestination(user, requested) {
  if (canAccessLab(user)) return labDestination(user, requested);
  return isCustomerStoreDestination(requested) ? requested : '/store';
}

export default function StoreAuthPage({ mode, standalone = false }) {
  const isRegister = mode === 'register';
  const { login, user } = useStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(location.state?.message || '');
  const [busy, setBusy] = useState(false);

  if (!isRegister && user) {
    if (!standalone) return <section className="store-panel"><h1>You are signed in</h1><Link to={canAccessLab(user) ? '/' : '/store/account'}>{canAccessLab(user) ? 'Go to the Virtual Lab' : 'Go to your account'}</Link></section>;
    return (
      <GateLabAuthShell>
        <section className="store-auth-card gatelab-auth-card">
          <div className="store-auth-icon"><ShieldCheck size={22} /></div>
          <div className="store-eyebrow">Session active</div>
          <h1>You are signed in</h1>
          <p>Continue as {roleLabel(user)}.</p>
          <Link className="store-button store-button-primary store-button-wide" to={canAccessLab(user) ? '/' : '/store'}>
            {canAccessLab(user) ? 'Continue to Virtual Lab' : 'Open Demo Store'} <ArrowRight size={16} />
          </Link>
          <Link className="store-button store-button-wide" to="/store">Open Demo Store</Link>
        </section>
      </GateLabAuthShell>
    );
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      if (isRegister) {
        await api.store.register({ name, email, password, ...(phone.trim() ? { phone: phone.trim() } : {}) });
        setSuccess('Account created. Sign in with your email and password.');
        setPassword('');
      } else {
        let result;
        if (standalone) {
          try {
            result = await api.store.customerLogin({ email: email.trim().toLowerCase(), password });
          } catch (customerError) {
            try {
              result = await api.login(email.trim(), password);
            } catch (_) {
              throw customerError;
            }
          }
        } else {
          result = await api.store.customerLogin({ email: email.trim(), password });
        }
        login(result);
        const requested = location.state?.from?.pathname;
        navigate(loginDestination(result.user, requested), { replace: true });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const card = (
    <section className={`store-auth-card${standalone ? ' gatelab-auth-card' : ''}`}>
      <div className="store-auth-icon">{isRegister ? <UserRound size={22} /> : <LockKeyhole size={22} />}</div>
      <div className="store-eyebrow">{isRegister ? 'Join the store' : 'Welcome back'}</div>
      <h1>{isRegister ? 'Create your account' : standalone ? 'Sign in to GateLab' : 'Sign in'}</h1>
      <p>{isRegister ? 'Set up a customer account to manage your orders.' : 'Use your customer account or an authorized lab account.'}</p>
      <Feedback error={error} success={success} />
      <form className="store-form" onSubmit={submit}>
        {isRegister && (
          <label>Full name<input required minLength="2" maxLength="80" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        )}
        <label>
          {standalone ? 'Email address or username' : 'Email address'}
          <input
            required
            type={standalone ? 'text' : 'email'}
            autoComplete={standalone ? 'username' : 'email'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {isRegister && (
          <label>Phone <span className="muted">(optional)</span><input maxLength="20" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        )}
        <label>Password<input required type="password" minLength={isRegister ? 8 : undefined} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="store-button store-button-primary store-button-wide" disabled={busy}>
          {busy ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'} <ArrowRight size={16} />
        </button>
      </form>
      <div className="store-auth-switch">
        {isRegister ? <>Already registered? <Link to="/store/login">Sign in</Link></> : <>{standalone ? 'New to GateLab?' : 'New to the store?'} <Link to="/store/register">Create an account</Link></>}
      </div>
      {standalone && (
        <div className="gatelab-auth-note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>Administrators and students continue to the dashboard. Customers continue to the Demo Store.</span>
        </div>
      )}
    </section>
  );

  if (standalone) return <GateLabAuthShell>{card}</GateLabAuthShell>;
  return <div className="store-auth-wrap">{card}</div>;
}
