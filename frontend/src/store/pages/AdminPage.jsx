import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PackagePlus, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, Loading, PageHeading } from '../StoreUI';

const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

function ProductEditor({ product, onSave, onCancel, busy }) {
  const [form, setForm] = useState({
    name: product?.name || '',
    description: product?.description || '',
    price: product?.price ?? '',
    category: product?.category || '',
    stock: product?.stock ?? 0,
  });

  function field(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  return (
    <form className="store-panel admin-product-form" onSubmit={(event) => {
      event.preventDefault();
      onSave({
        name: form.name,
        description: form.description,
        price: Number(form.price),
        category: form.category,
        stock: Number(form.stock),
      });
    }}>
      <div className="admin-form-heading"><PackagePlus size={19} /><h2>{product ? 'Edit product' : 'Add product'}</h2></div>
      <div className="store-form-row">
        <label>Product name<input required minLength="2" maxLength="100" value={form.name} onChange={(e) => field('name', e.target.value)} /></label>
        <label>Category<input required minLength="2" maxLength="50" value={form.category} onChange={(e) => field('category', e.target.value)} /></label>
      </div>
      <label>Description<textarea maxLength="1000" rows="3" value={form.description} onChange={(e) => field('description', e.target.value)} /></label>
      <div className="store-form-row">
        <label>Price (INR)<input required type="number" min="0" max="10000000" step="0.01" value={form.price} onChange={(e) => field('price', e.target.value)} /></label>
        <label>Stock<input required type="number" min="0" max="1000000" step="1" value={form.stock} onChange={(e) => field('stock', e.target.value)} /></label>
      </div>
      <div className="admin-form-actions">
        <button className="store-button store-button-primary" disabled={busy}>{busy ? 'Saving...' : product ? 'Save changes' : 'Create product'}</button>
        <button className="store-button" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ProductManagement({ token }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editorProduct, setEditorProduct] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.store.listProducts({ page, limit: 12 }).then((result) => {
      if (active) {
        setProducts(result.products || []);
        setPages(result.pages || 1);
      }
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [page, refresh]);

  async function saveProduct(body) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      if (editorProduct) await api.store.updateProduct(token, editorProduct._id, body);
      else await api.store.createProduct(token, body);
      setSuccess(editorProduct ? 'Product updated.' : 'Product created.');
      setEditorProduct(undefined);
      setRefresh((value) => value + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function discontinue(product) {
    if (!window.confirm(`Discontinue "${product.name}"? It will no longer appear in the customer catalog.`)) return;
    setError('');
    setSuccess('');
    try {
      await api.store.deleteProduct(token, product._id);
      setProducts((current) => current.filter((entry) => entry._id !== product._id));
      setSuccess('Product discontinued. Its record remains available for order history.');
      if (products.length === 1 && page > 1) setPage(page - 1);
      else setRefresh((value) => value + 1);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-heading">
        <div><h2>Product catalog</h2><p>Changes are authorized by the Product Service.</p></div>
        {!editorProduct && <button className="store-button store-button-primary" onClick={() => setEditorProduct(null)}><Plus size={15} /> Add product</button>}
      </div>
      <Feedback error={error} success={success} />
      {editorProduct !== undefined && (
        <ProductEditor
          key={editorProduct?._id || 'new'}
          product={editorProduct}
          busy={busy}
          onSave={saveProduct}
          onCancel={() => setEditorProduct(undefined)}
        />
      )}
      {loading ? <Loading label="Loading product catalog..." /> : products.length === 0 ? (
        <div className="store-empty store-empty-panel">No active products to manage.</div>
      ) : (
        <section className="store-panel table-scroll">
          <table className="store-table">
            <thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{products.map((product) => (
              <tr key={product._id}>
                <td><strong>{product.name}</strong><small className="admin-product-description">{product.description}</small></td>
                <td>{product.category}</td>
                <td>{formatPrice(product.price)}</td>
                <td>{product.stock}</td>
                <td><span className="order-status status-active">{product.status}</span></td>
                <td><div className="admin-row-actions">
                  <button className="store-button store-button-small" onClick={() => setEditorProduct(product)}><Pencil size={13} /> Edit</button>
                  <button className="store-button store-button-danger store-button-small" onClick={() => discontinue(product)}><Trash2 size={13} /> Discontinue</button>
                </div></td>
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

function OrderManagement({ token }) {
  const [orders, setOrders] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [search, setSearch] = useState({ status: '', user: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.store.listAdminOrders(token, { ...search, page, limit: 10 }).then((result) => {
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
  }, [token, search, page, refresh]);

  async function updateStatus(order, status) {
    if (status === order.status) return;
    setError('');
    setSuccess('');
    try {
      await api.store.updateOrderStatus(token, order._id, status);
      setSuccess(`Order ${order._id.slice(-8).toUpperCase()} updated to ${status}.`);
      setRefresh((value) => value + 1);
    } catch (e) {
      setError(e.message);
    }
  }

  function applyFilters(event) {
    event.preventDefault();
    setPage(1);
    setSearch({ status: statusFilter, user: userFilter.trim() });
  }

  return (
    <div className="admin-section">
      <div className="admin-section-heading"><div><h2>Order management</h2><p>Filter orders and update valid order statuses.</p></div></div>
      <form className="admin-filters" onSubmit={applyFilters}>
        <label>Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label>Customer ID
          <input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="Optional 24-character ID" />
        </label>
        <button className="store-button store-button-primary">Apply filters</button>
        <button className="store-button" type="button" onClick={() => { setStatusFilter(''); setUserFilter(''); setPage(1); setSearch({ status: '', user: '' }); }}>Clear</button>
      </form>
      <Feedback error={error} success={success} />
      {loading ? <Loading label="Loading all orders..." /> : orders.length === 0 ? (
        <div className="store-empty store-empty-panel">No orders match these filters.</div>
      ) : (
        <section className="store-panel table-scroll">
          <table className="store-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th><th>Update status</th><th></th></tr></thead>
            <tbody>{orders.map((order) => {
              const nextStatuses = order.status === 'pending' ? ['confirmed', 'cancelled']
                : order.status === 'confirmed' ? ['shipped', 'cancelled']
                  : order.status === 'shipped' ? ['delivered'] : [];
              return (
                <tr key={order._id}>
                  <td className="store-order-id">{order._id.slice(-8).toUpperCase()}</td>
                  <td>{order.user?.name || order.user?.email || String(order.user)}</td>
                  <td>{new Date(order.createdAt).toLocaleDateString()}</td>
                  <td>{formatPrice(order.totalAmount)}</td>
                  <td><span className={`order-status status-${order.status}`}>{order.status}</span></td>
                  <td>
                    <select aria-label={`Update status for order ${order._id}`} value="" disabled={!nextStatuses.length} onChange={(e) => updateStatus(order, e.target.value)}>
                      <option value="">{nextStatuses.length ? 'Select status' : 'Final status'}</option>
                      {nextStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </td>
                  <td><Link className="store-table-link" to={`/store/orders/${order._id}`}>Details</Link></td>
                </tr>
              );
            })}</tbody>
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

export default function AdminPage() {
  const { token, user } = useStore();
  const [tab, setTab] = useState('products');
  return (
    <div className="store-page">
      <PageHeading eyebrow="Store administration" title="Admin console" description={`Signed in as ${user?.email || 'administrator'}. Protected operations are checked by the backend.`}>
        <span className="admin-role-badge"><ShieldCheck size={15} /> Admin</span>
      </PageHeading>
      <div className="store-tabs" role="tablist" aria-label="Administration sections">
        <button role="tab" aria-selected={tab === 'products'} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Products</button>
        <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Orders</button>
      </div>
      {tab === 'products' ? <ProductManagement token={token} /> : <OrderManagement token={token} />}
    </div>
  );
}
