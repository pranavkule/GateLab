const PRODUCTS = [
  {
    name: 'Mechanical Keyboard K2',
    description: 'Hot-swappable 75% mechanical keyboard with red switches and RGB backlight.',
    price: 3499, category: 'Electronics', stock: 25,
  },
  {
    name: '27 inch 4K Monitor',
    description: '27-inch IPS 4K UHD monitor with 99% sRGB coverage and height-adjustable stand.',
    price: 18999, category: 'Electronics', stock: 10,
  },
  {
    name: 'Wireless Mouse M590',
    description: 'Silent-click wireless mouse with dual device pairing and 24 month battery life.',
    price: 1299, category: 'Accessories', stock: 60,
  },
  {
    name: 'USB-C Hub 7-in-1',
    description: 'Aluminum USB-C hub with 4K HDMI, 100W PD passthrough and SD card reader.',
    price: 2199, category: 'Accessories', stock: 35,
  },
  {
    name: 'Noise-Cancel Headphones H9',
    description: 'Over-ear hybrid active noise cancelling headphones with 30 hour playtime.',
    price: 7999, category: 'Electronics', stock: 15,
  },
  {
    name: 'Laptop Stand Aluminum',
    description: 'Ergonomic aluminum laptop stand, adjustable height, fits 11-17 inch laptops.',
    price: 1799, category: 'Office', stock: 30,
  },
  {
    name: 'Webcam Stream 1080p',
    description: 'Full HD webcam with auto light correction and dual noise-reducing mics.',
    price: 2499, category: 'Electronics', stock: 40,
  },
  {
    name: 'Desk Mat Classic',
    description: 'PU leather desk mat 900x400 mm with stitched edges and anti-slip base.',
    price: 899, category: 'Office', stock: 0, status: 'discontinued',
  },
];

async function seedCatalogProducts(Product) {
  let created = 0;
  for (const product of PRODUCTS) {
    const result = await Product.updateOne(
      { name: product.name },
      { $setOnInsert: { ...product } },
      { upsert: true }
    );
    if (result.upsertedCount) created += result.upsertedCount;
  }
  return { created, alreadyPresent: PRODUCTS.length - created };
}

module.exports = { PRODUCTS, seedCatalogProducts };
