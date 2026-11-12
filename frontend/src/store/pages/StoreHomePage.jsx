import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Package, Search, ShoppingCart } from 'lucide-react';
import { api } from '../../services/api';
import { useStore } from '../StoreContext';
import { Feedback, formatPrice, Loading, PageHeading } from '../StoreUI';

function ProductCard({ product, addToCart }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  function add() {
    setError('');
    try {
      addToCart(product);
      setMessage('Added to cart');
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <article className="product-card">
      <Link className="product-art" to={`/store/products/${product._id}`} aria-label={`View ${product.name}`}>
        <Package size={38} strokeWidth={1.4} />
        <span>{product.category}</span>
      </Link>
      <div className="product-card-content">
        <div className="store-eyebrow">{product.category}</div>
        <Link className="product-title" to={`/store/products/${product._id}`}>{product.name}</Link>
        <div className="product-price">{formatPrice(product.price)}</div>
        <div className={`stock-label ${product.stock > 0 ? 'in-stock' : 'out-stock'}`}>
          {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
        </div>
        <Feedback error={error} success={message} />
        <button className="store-button store-button-primary product-add" onClick={add} disabled={product.stock < 1}>
          <ShoppingCart size={15} /> Add to cart
        </button>
      </div>
    </article>
  );
}

export default function StoreHomePage() {
  const { addToCart } = useStore();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [categoryError, setCategoryError] = useState('');

  useEffect(() => {
    let active = true;
    api.store.listProducts({ limit: 50 }).then((result) => {
      if (active) setCategories([...new Set((result.products || []).map((p) => p.category).filter(Boolean))].sort());
    }).catch((e) => {
      if (active) setCategoryError(e.message);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const result = await api.store.listProducts({ search: search.trim(), category, page, limit: 12 });
        if (!active) return;
        setProducts(result.products || []);
        setPages(result.pages || 1);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    }, search ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [search, category, page]);

  function changeCategory(value) {
    setCategory(value);
    setPage(1);
  }

  return (
    <div className="store-page">
      <section className="store-hero">
        <div>
          <div className="store-eyebrow">Real catalog · real inventory</div>
          <h1>Good gear for<br />better work.</h1>
          <p>Browse the live GateLab catalog and place an order through the API gateway.</p>
          <a className="store-button store-button-light" href="#catalog">Explore products <ArrowRight size={16} /></a>
        </div>
        <div className="store-hero-mark" aria-hidden="true"><Package size={92} strokeWidth={1} /></div>
      </section>

      <section id="catalog" className="store-catalog">
        <PageHeading eyebrow="The catalog" title="Shop products" description="Product details, prices, and stock are loaded from the Product Service." />
        <div className="store-filters">
          <label className="store-search">
            <Search size={17} />
            <input aria-label="Search products" placeholder="Search products..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </label>
          <label className="store-category-filter">
            <span className="sr-only">Filter by category</span>
            <select aria-label="Filter by category" value={category} onChange={(e) => changeCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>
        <Feedback error={categoryError} />
        <Feedback error={error} />
        {loading ? <Loading label="Loading live catalog..." /> : products.length === 0 ? (
          <div className="store-empty"><Package size={30} /><strong>No products found</strong><span>Try a different search or category.</span></div>
        ) : (
          <div className="product-grid">
            {products.map((product) => <ProductCard key={product._id} product={product} addToCart={addToCart} />)}
          </div>
        )}
        {pages > 1 && (
          <div className="store-pagination">
            <button className="store-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button className="store-button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
