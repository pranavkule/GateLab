import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Package, ShoppingCart } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, Loading } from '../StoreUI';

export default function ProductDetailPage() {
  const { id } = useParams();
  const { addToCart } = useStore();
  const [product, setProduct] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setProduct(null);
    setError('');
    api.store.getProduct(id).then((result) => {
      if (active) setProduct(result.product);
    }).catch((e) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [id]);

  function add() {
    setError('');
    setSuccess('');
    try {
      addToCart(product, quantity);
      setSuccess('Added to your cart.');
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <Loading label="Loading product..." />;
  if (!product) {
    return <section className="store-panel"><Feedback error={error || 'Product not found'} /><Link to="/store">Back to catalog</Link></section>;
  }

  return (
    <div className="store-page">
      <Link className="store-back-link" to="/store"><ArrowLeft size={15} /> Back to catalog</Link>
      <section className="store-product-detail">
        <div className="product-art product-art-large"><Package size={76} strokeWidth={1.2} /><span>{product.category}</span></div>
        <div className="store-product-copy">
          <div className="store-eyebrow">{product.category}</div>
          <h1>{product.name}</h1>
          <div className="product-price product-price-large">{formatPrice(product.price)}</div>
          <p>{product.description || 'Product details are provided by the live catalog.'}</p>
          <div className={`stock-label ${product.stock > 0 ? 'in-stock' : 'out-stock'}`}>
            {product.stock > 0 ? `${product.stock} available` : 'Currently out of stock'}
          </div>
          <Feedback error={error} success={success} />
          <div className="store-buy-row">
            <label className="store-quantity">
              <span>Quantity</span>
              <input aria-label="Quantity" type="number" min="1" max={product.stock} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <button className="store-button store-button-primary" onClick={add} disabled={product.stock < 1 || quantity > product.stock}>
              <ShoppingCart size={16} /> Add to cart
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
