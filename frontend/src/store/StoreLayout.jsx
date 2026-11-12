import React from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Activity, ShoppingBag, ShoppingCart } from 'lucide-react';
import { useStore } from './StoreContext';

export default function StoreLayout() {
  const { user, cartCount, logout } = useStore();
  const navigate = useNavigate();

  function signOut() {
    logout();
    navigate('/store', { replace: true });
  }

  return (
    <div className="store-app">
      <header className="store-header">
        <Link className="store-brand" to="/store">
          <ShoppingBag size={21} />
          <span>GateLab Store</span>
        </Link>
        <nav className="store-nav" aria-label="Store navigation">
          <NavLink to="/store" end>Shop</NavLink>
          {user && <NavLink to="/store/orders">My orders</NavLink>}
          {user && <NavLink to="/store/account">My account</NavLink>}
          {user && user.role === 'admin' && <NavLink to="/store/admin">Admin</NavLink>}
          <Link className="store-cart-link" to="/store/cart" aria-label={`Cart, ${cartCount} items`}>
            <ShoppingCart size={17} /> Cart <span className="cart-count">{cartCount}</span>
          </Link>
          {user
            ? <button className="store-nav-button" onClick={signOut}>Log out</button>
            : <NavLink to="/store/login">Sign in</NavLink>}
        </nav>
      </header>
      <main className="store-main">
        <Outlet />
      </main>
      <footer className="store-footer">
        <span>GateLab Store</span>
        <Link to="/">Gateway Virtual Lab <Activity size={14} /></Link>
      </footer>
    </div>
  );
}
