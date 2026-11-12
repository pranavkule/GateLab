import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, LockKeyhole } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, Loading, PageHeading } from '../StoreUI';

function OrderReceipt({ order }) {
  return (
    <section className="store-panel store-receipt">
      <div className="receipt-icon"><CheckCircle2 size={30} /></div>
      <div className="store-eyebrow">Order confirmed</div>
      <h1>Thank you for your order.</h1>
      <p>Your order has been placed successfully.</p>
      <div className="receipt-id">Order ID <strong>{order._id}</strong></div>
      <div className="receipt-lines">
        {(order.items || []).map((item, index) => (
          <div className="summary-row" key={`${item.product}-${index}`}>
            <span>{item.name} × {item.quantity}</span>
            <strong>{formatPrice(item.price * item.quantity)}</strong>
          </div>
        ))}
        <div className="summary-row summary-total"><span>Order total</span><strong>{formatPrice(order.totalAmount)}</strong></div>
      </div>
      <div className="receipt-actions">
        <Link className="store-button store-button-primary" to={`/store/orders/${order._id}`}>View order details</Link>
        <Link className="store-button" to="/store">Continue shopping</Link>
      </div>
    </section>
  );
}

export default function CheckoutPage({ confirmation = false }) {
  const { token, user, cart, cartTotal, clearCart } = useStore();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [order, setOrder] = useState(location.state?.order || null);
  const [loading, setLoading] = useState(confirmation && !location.state?.order);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!confirmation || order || !id) return undefined;
    let active = true;
    api.store.getOrder(token, id).then((result) => {
      if (active) setOrder(result.order);
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [confirmation, id, order, token]);

  async function placeOrder(event) {
    event.preventDefault();
    if (!cart.length) {
      setError('Your cart is empty.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.store.createOrder(token, {
        items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      });
      clearCart();
      navigate(`/store/confirmation/${result.order._id}`, { replace: true, state: { order: result.order } });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (confirmation) {
    if (loading) return <Loading label="Loading your order confirmation..." />;
    return (
      <div className="store-page">
        {error && <Feedback error={error} />}
        {order ? <OrderReceipt order={order} /> : <section className="store-panel"><Link to="/store/orders">Back to my orders</Link></section>}
      </div>
    );
  }

  return (
    <div className="store-page">
      <Link className="store-back-link" to="/store/cart"><ArrowLeft size={15} /> Back to cart</Link>
      <PageHeading eyebrow="Secure checkout" title="Review your order" description="No payment is collected. The Order Service checks live stock and calculates the final total." />
      {!cart.length ? (
        <section className="store-empty store-empty-panel">
          <strong>Your cart is empty</strong>
          <Link className="store-button store-button-primary" to="/store">Return to the catalog</Link>
        </section>
      ) : (
        <div className="store-cart-layout">
          <section className="store-panel checkout-lines">
            <h2>Items</h2>
            {cart.map((item) => (
              <div className="checkout-line" key={item.productId}>
                <div><strong>{item.name}</strong><span>Quantity {item.quantity}</span></div>
                <strong>{formatPrice(item.price * item.quantity)}</strong>
              </div>
            ))}
            <div className="summary-row summary-total"><span>Estimated subtotal</span><strong>{formatPrice(cartTotal)}</strong></div>
            <p className="store-note">This estimate is for display only. The server calculates the actual order total from current catalog prices.</p>
          </section>
          <form className="store-panel store-order-summary" onSubmit={placeOrder}>
            <h2>Place order</h2>
            <div className="checkout-account"><LockKeyhole size={16} /><span>Ordering as <strong>{user?.name || user?.email}</strong></span></div>
            <div className="summary-row"><span>Items</span><strong>{cart.reduce((sum, item) => sum + item.quantity, 0)}</strong></div>
            <Feedback error={error} />
            <button className="store-button store-button-primary store-button-wide" disabled={busy}>
              {busy ? 'Placing order...' : 'Place order'} <CheckCircle2 size={16} />
            </button>
            <p>Inventory is checked atomically when you place the order. The cart remains intact if the order fails.</p>
          </form>
        </div>
      )}
    </div>
  );
}
