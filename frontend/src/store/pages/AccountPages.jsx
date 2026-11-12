import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, UserRound } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, Loading, PageHeading } from '../StoreUI';

function ProfilePage() {
  const { token } = useStore();
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '', line1: '', city: '', state: '', postalCode: '', country: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let active = true;
    api.store.getProfile(token).then((result) => {
      if (!active) return;
      const user = result.user;
      setProfile(user);
      setForm({
        name: user.name || '', phone: user.phone || '',
        line1: user.address?.line1 || '', city: user.address?.city || '',
        state: user.address?.state || '', postalCode: user.address?.postalCode || '',
        country: user.address?.country || '',
      });
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [token]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await api.store.updateProfile(token, {
        name: form.name,
        phone: form.phone,
        address: {
          line1: form.line1,
          city: form.city,
          state: form.state,
          postalCode: form.postalCode,
          country: form.country,
        },
      });
      setProfile(result.user);
      setSuccess('Your profile has been updated.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="Loading your profile..." />;
  return (
    <div className="store-page store-narrow">
      <PageHeading eyebrow="Customer account" title="My profile" description="Manage the profile details associated with your account." />
      <section className="store-panel">
        <div className="profile-identity"><div className="profile-avatar"><UserRound size={22} /></div><div><strong>{profile?.email}</strong><span>{profile?.role}</span></div></div>
        <Feedback error={error} success={success} />
        <form className="store-form store-profile-form" onSubmit={save}>
          <label>Full name<input required minLength="2" maxLength="80" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email address<input value={profile?.email || ''} disabled /></label>
          <label>Phone<input maxLength="20" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>Address line<input value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} /></label>
          <div className="store-form-row">
            <label>City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
            <label>State<input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></label>
          </div>
          <div className="store-form-row">
            <label>Postal code<input value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></label>
            <label>Country<input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></label>
          </div>
          <button className="store-button store-button-primary" disabled={busy}>{busy ? 'Saving...' : 'Save profile'}</button>
        </form>
      </section>
    </div>
  );
}

function OrdersPage() {
  const { token } = useStore();
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.store.listOrders(token, { page, limit: 10 }).then((result) => {
      if (active) {
        setOrders(result.orders || []);
        setPages(result.pages || 1);
      }
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [token, page]);

  return (
    <div className="store-page">
      <PageHeading eyebrow="Customer account" title="My orders" description="Your order history, loaded from the Order Service." />
      <Feedback error={error} />
      {loading ? <Loading label="Loading your orders..." /> : orders.length === 0 ? (
        <section className="store-empty store-empty-panel"><ClipboardList size={34} /><strong>No orders yet</strong><span>Your completed checkouts will appear here.</span><Link className="store-button store-button-primary" to="/store">Browse products</Link></section>
      ) : (
        <section className="store-panel table-scroll">
          <table className="store-table">
            <thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Status</th><th>Total</th><th></th></tr></thead>
            <tbody>{orders.map((order) => (
              <tr key={order._id}>
                <td className="store-order-id">{order._id.slice(-8).toUpperCase()}</td>
                <td>{new Date(order.createdAt).toLocaleDateString()}</td>
                <td>{order.items?.reduce((count, item) => count + item.quantity, 0) || 0}</td>
                <td><span className={`order-status status-${order.status}`}>{order.status}</span></td>
                <td>{formatPrice(order.totalAmount)}</td>
                <td><Link className="store-table-link" to={`/store/orders/${order._id}`}>View details</Link></td>
              </tr>
            ))}</tbody>
          </table>
          {pages > 1 && <div className="store-pagination store-pagination-padded">
            <button className="store-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button className="store-button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>}
        </section>
      )}
    </div>
  );
}

function OrderDetailPage() {
  const { id } = useParams();
  const { token } = useStore();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.store.getOrder(token, id).then((result) => {
      if (active) setOrder(result.order);
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [id, token]);

  if (loading) return <Loading label="Loading order details..." />;
  return (
    <div className="store-page store-narrow">
      <Link className="store-back-link" to="/store/orders"><ArrowLeft size={15} /> Back to my orders</Link>
      <Feedback error={error} />
      {order && (
        <>
          <PageHeading eyebrow="Order details" title={`Order ${order._id.slice(-8).toUpperCase()}`} description={`Placed ${new Date(order.createdAt).toLocaleString()}`} />
          <section className="store-panel order-detail-panel">
            <div className="summary-row"><span>Status</span><span className={`order-status status-${order.status}`}>{order.status}</span></div>
            {(order.items || []).map((item, index) => (
              <div className="checkout-line" key={`${item.product}-${index}`}>
                <div><strong>{item.name}</strong><span>{formatPrice(item.price)} each · Quantity {item.quantity}</span></div>
                <strong>{formatPrice(item.price * item.quantity)}</strong>
              </div>
            ))}
            <div className="summary-row summary-total"><span>Order total</span><strong>{formatPrice(order.totalAmount)}</strong></div>
          </section>
        </>
      )}
    </div>
  );
}

export default function AccountPages({ page }) {
  if (page === 'profile') return <ProfilePage />;
  if (page === 'orders') return <OrdersPage />;
  return <OrderDetailPage />;
}
