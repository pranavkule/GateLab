import React, { createContext, useContext, useMemo, useState } from 'react';
import { readSession as readStoredSession, SESSION_KEY } from '../services/session';

const StoreContext = createContext(null);
const CART_KEY = 'gatelab.store.cart';

function isSessionValid(session) {
  if (!session || !session.token || !session.user) return false;
  try {
    const payload = JSON.parse(atob(session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !payload.exp || payload.exp * 1000 > Date.now();
  } catch (_) {
    return false;
  }
}

function readSession() {
  try {
    const session = readStoredSession();
    return isSessionValid(session) ? session : null;
  } catch (_) {
    return null;
  }
}

function readCart() {
  try {
    const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(cart)) return [];
    return cart.filter((item) =>
      item && typeof item.productId === 'string' &&
      Number.isInteger(item.quantity) && item.quantity > 0
    );
  } catch (_) {
    return [];
  }
}

export function StoreProvider({ children }) {
  const [session, setSession] = useState(readSession);
  const [cart, setCart] = useState(readCart);

  function login(result) {
    if (!result || typeof result.token !== 'string' || !result.user) {
      throw new Error('The Auth Service returned an unexpected login response');
    }
    const next = { token: result.token, user: result.user };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
  }

  function addToCart(product, quantity = 1) {
    if (!product || !product._id) throw new Error('Product information is unavailable');
    const stock = Number(product.stock) || 0;
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Choose a valid quantity');
    if (stock < 1) throw new Error('This product is out of stock');
    const productId = String(product._id);
    const existing = cart.find((item) => item.productId === productId);
    const nextQuantity = (existing ? existing.quantity : 0) + quantity;
    if (nextQuantity > stock) throw new Error(`Only ${stock} in stock`);
    const item = {
      productId,
      name: product.name,
      category: product.category,
      price: Number(product.price),
      stock,
      quantity: nextQuantity,
    };
    setCart((current) => existing
      ? current.map((entry) => entry.productId === item.productId ? item : entry)
      : [...current, item]);
  }

  function setCartQuantity(productId, quantity) {
    if (!Number.isInteger(quantity)) throw new Error('Quantity must be a whole number');
    if (quantity < 1) {
      setCart((current) => current.filter((item) => item.productId !== productId));
      return;
    }
    const item = cart.find((entry) => entry.productId === productId);
    if (item && quantity > item.stock) throw new Error(`Only ${item.stock} in stock`);
    setCart((current) => current.map((item) => {
      return item.productId === productId ? { ...item, quantity } : item;
    }));
  }

  function removeFromCart(productId) {
    setCart((current) => current.filter((item) => item.productId !== productId));
  }

  function clearCart() {
    setCart([]);
  }

  const value = useMemo(() => ({
    session: isSessionValid(session) ? session : null,
    user: isSessionValid(session) ? session.user : null,
    token: isSessionValid(session) ? session.token : null,
    cart,
    cartCount: cart.reduce((total, item) => total + item.quantity, 0),
    cartTotal: cart.reduce((total, item) => total + item.price * item.quantity, 0),
    login, logout, addToCart, setCartQuantity, removeFromCart, clearCart,
  }), [session, cart]);

  React.useEffect(() => {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used within StoreProvider');
  return value;
}
