import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, PageHeading } from '../StoreUI';

export default function CartPage() {
  const { cart, cartTotal, setCartQuantity, removeFromCart } = useStore();
  const [error, setError] = useState('');

  function changeQuantity(productId, quantity) {
    setError('');
    try {
      setCartQuantity(productId, quantity);
    } catch (e) {
      setError(e.message);
    }
  }

  if (!cart.length) {
    return (
      <div className="store-page">
        <PageHeading eyebrow="Your selection" title="Shopping cart" />
        <section className="store-empty store-empty-panel">
          <ShoppingBag size={36} />
          <strong>Your cart is empty</strong>
          <span>Browse the catalog and add a product to get started.</span>
          <Link className="store-button store-button-primary" to="/store">Explore products</Link>
        </section>
      </div>
    );
  }

  return (
    <div className="store-page">
      <PageHeading eyebrow="Your selection" title="Shopping cart" description={`${cart.reduce((sum, item) => sum + item.quantity, 0)} item(s) in your cart.`} />
      <Feedback error={error} />
      <div className="store-cart-layout">
        <section className="store-panel store-cart-items">
          {cart.map((item) => (
            <article className="store-cart-item" key={item.productId}>
              <div className="cart-item-art"><ShoppingBag size={23} /></div>
              <div className="cart-item-info">
                <Link to={`/store/products/${item.productId}`}>{item.name}</Link>
                <span>{item.category}</span>
                <span>{formatPrice(item.price)} each · {item.stock} in stock</span>
              </div>
              <div className="cart-item-quantity">
                <button aria-label={`Decrease ${item.name} quantity`} onClick={() => changeQuantity(item.productId, item.quantity - 1)}><Minus size={14} /></button>
                <input aria-label={`${item.name} quantity`} type="number" min="1" max={item.stock} value={item.quantity} onChange={(e) => changeQuantity(item.productId, Number(e.target.value))} />
                <button aria-label={`Increase ${item.name} quantity`} disabled={item.quantity >= item.stock} onClick={() => changeQuantity(item.productId, item.quantity + 1)}><Plus size={14} /></button>
              </div>
              <strong className="cart-item-subtotal">{formatPrice(item.price * item.quantity)}</strong>
              <button className="store-icon-button" aria-label={`Remove ${item.name}`} onClick={() => removeFromCart(item.productId)}><Trash2 size={16} /></button>
            </article>
          ))}
        </section>
        <aside className="store-panel store-order-summary">
          <h2>Order summary</h2>
          <div className="summary-row"><span>Subtotal estimate</span><strong>{formatPrice(cartTotal)}</strong></div>
          <p>Final prices and inventory are verified by the Order Service at checkout.</p>
          <Link className="store-button store-button-primary store-button-wide" to="/store/checkout">Continue to checkout <ArrowRight size={16} /></Link>
          <Link className="store-continue-link" to="/store">Continue shopping</Link>
        </aside>
      </div>
    </div>
  );
}
