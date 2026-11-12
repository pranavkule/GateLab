import React from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import LabPage from './pages/LabPage';
import ConfigPage from './pages/ConfigPage';
import GuidePage from './pages/GuidePage';
import StorefrontApp, { Protected } from './store/StorefrontApp';
import StoreHomePage from './store/pages/StoreHomePage';
import ProductDetailPage from './store/pages/ProductDetailPage';
import StoreAuthPage from './store/pages/StoreAuthPage';
import CartPage from './store/pages/CartPage';
import CheckoutPage from './store/pages/CheckoutPage';
import AccountPages from './store/pages/AccountPages';
import AdminPage from './store/pages/AdminPage';
import { StoreProvider, useStore } from './store/StoreContext';

export default function App() {
  return (
    <StoreProvider>
      <div className="app">
        <Routes>
          <Route path="/store" element={<StorefrontApp />}>
            <Route index element={<StoreHomePage />} />
            <Route path="products/:id" element={<ProductDetailPage />} />
            <Route path="login" element={<StoreAuthPage mode="login" />} />
            <Route path="register" element={<StoreAuthPage mode="register" />} />
            <Route path="cart" element={<CartPage />} />
            <Route path="checkout" element={<Protected><CheckoutPage /></Protected>} />
            <Route path="confirmation/:id" element={<Protected><CheckoutPage confirmation /></Protected>} />
            <Route path="account" element={<Protected><AccountPages page="profile" /></Protected>} />
            <Route path="orders" element={<Protected><AccountPages page="orders" /></Protected>} />
            <Route path="orders/:id" element={<Protected><AccountPages page="order" /></Protected>} />
            <Route path="admin" element={<Protected admin><AdminPage /></Protected>} />
            <Route path="*" element={<Navigate to="/store" replace />} />
          </Route>
          <Route path="/" element={<LabAccess><LabLayout><LabPage /></LabLayout></LabAccess>} />
          <Route path="/configuration" element={<LabAccess><LabLayout><ConfigPage /></LabLayout></LabAccess>} />
          <Route path="/guide" element={<LabAccess><LabLayout><GuidePage /></LabLayout></LabAccess>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </StoreProvider>
  );
}

function LabAccess({ children }) {
  const { user } = useStore();
  const location = useLocation();

  if (import.meta.env.PROD && !user) {
    return <Navigate to="/store/login" replace state={{ from: location }} />;
  }
  if (import.meta.env.PROD && user.role !== 'admin') {
    return (
      <section className="store-panel store-message">
        <h1>Administrator access required</h1>
        <p>The Virtual Lab and configuration controls are available only to an administrator.</p>
        <Link className="store-button store-button-primary" to="/store">Return to the store</Link>
      </section>
    );
  }
  return children;
}

function LabLayout({ children }) {
  return (
    <>
      <Navbar />
      <div className="app-body">{children}</div>
    </>
  );
}
