import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, LockKeyhole, UserRound } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback } from '../StoreUI';

export default function StoreAuthPage({ mode }) {
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

  if (!isRegister && user) return <section className="store-panel"><h1>You are signed in</h1><Link to="/store/account">Go to your account</Link></section>;

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
        const result = await api.store.customerLogin({ email, password });
        login(result);
        const destination = location.state?.from?.pathname || '/store/account';
        navigate(destination, { replace: true });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="store-auth-wrap">
      <section className="store-auth-card">
        <div className="store-auth-icon">{isRegister ? <UserRound size={22} /> : <LockKeyhole size={22} />}</div>
        <div className="store-eyebrow">{isRegister ? 'Join the store' : 'Welcome back'}</div>
        <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        <p>{isRegister ? 'Set up a customer account to manage your orders.' : 'Use your customer account or an authorized administrator account.'}</p>
        <Feedback error={error} success={success} />
        <form className="store-form" onSubmit={submit}>
          {isRegister && (
            <label>Full name<input required minLength="2" maxLength="80" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          )}
          <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {isRegister && (
            <label>Phone <span className="muted">(optional)</span><input maxLength="20" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          )}
          <label>Password<input required type="password" minLength={isRegister ? 8 : undefined} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="store-button store-button-primary store-button-wide" disabled={busy}>
            {busy ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'} <ArrowRight size={16} />
          </button>
        </form>
        <div className="store-auth-switch">
          {isRegister ? <>Already registered? <Link to="/store/login">Sign in</Link></> : <>New to the store? <Link to="/store/register">Create an account</Link></>}
        </div>
      </section>
    </div>
  );
}
