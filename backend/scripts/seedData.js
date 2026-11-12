// Seeds the e-commerce application data (idempotent).
//
// Re-running is safe: user profiles are upserted by unique email, products by
// unique name (existing stock is never reset), and sample orders are created
// only when the orders collection is empty.
//
// Usage: npm run seed:data
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed development demo data in production.');
  process.exit(1);
}
const { connectDb, disconnectDb } = require('../db');
const { UserProfile, Product, Order } = require('../models');
const { hashPassword } = require('../utils/password');

const USERS = [
  {
    name: 'Aarav Mehta',
    email: 'aarav.mehta@example.com',
    password: 'Admin@123',
    role: 'admin',
    phone: '+91 98200 11223',
    address: { line1: '12 Marine Drive', city: 'Mumbai', state: 'Maharashtra', postalCode: '400020' },
  },
  {
    name: 'Diya Sharma',
    email: 'diya.sharma@example.com',
    password: 'Customer@123',
    role: 'customer',
    phone: '+91 98111 44556',
    address: { line1: '44 Hauz Khas Village', city: 'New Delhi', state: 'Delhi', postalCode: '110016' },
  },
  {
    name: 'Rohan Iyer',
    email: 'rohan.iyer@example.com',
    password: 'Customer@123',
    role: 'customer',
    phone: '+91 99001 77889',
    address: { line1: '7 Brigade Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001' },
  },
];

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

async function seedUsers() {
  let created = 0;
  for (const u of USERS) {
    const res = await UserProfile.updateOne(
      { email: u.email },
      {
        $setOnInsert: {
          name: u.name,
          email: u.email,
          passwordHash: await hashPassword(u.password),
          role: u.role,
          phone: u.phone,
          address: u.address,
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) created += res.upsertedCount;
  }
  console.log(`[seed] user profiles: ${created} created, ${USERS.length - created} already present`);
}

async function seedProducts() {
  let created = 0;
  for (const p of PRODUCTS) {
    // $setOnInsert keeps existing stock/price on re-runs (no catalog reset).
    const res = await Product.updateOne(
      { name: p.name },
      { $setOnInsert: { ...p } },
      { upsert: true }
    );
    if (res.upsertedCount) created += res.upsertedCount;
  }
  console.log(`[seed] products: ${created} created, ${PRODUCTS.length - created} already present`);
}

async function seedOrders() {
  const existing = await Order.countDocuments();
  if (existing > 0) {
    console.log(`[seed] orders: ${existing} already present, skipping sample orders`);
    return;
  }

  const [diya, rohan] = await Promise.all([
    UserProfile.findOne({ email: 'diya.sharma@example.com' }).lean(),
    UserProfile.findOne({ email: 'rohan.iyer@example.com' }).lean(),
  ]);
  const products = await Product.find({ name: { $in: ['Wireless Mouse M590', 'USB-C Hub 7-in-1', 'Mechanical Keyboard K2'] } }).lean();
  const byName = Object.fromEntries(products.map((p) => [p.name, p]));

  const mouse = byName['Wireless Mouse M590'];
  const hub = byName['USB-C Hub 7-in-1'];
  const keyboard = byName['Mechanical Keyboard K2'];
  if (!diya || !rohan || !mouse || !hub || !keyboard) throw new Error('Seed data incomplete - cannot build sample orders');

  const orders = [
    {
      user: diya._id,
      items: [
        { product: mouse._id, name: mouse.name, price: mouse.price, quantity: 2 },
        { product: hub._id, name: hub.name, price: hub.price, quantity: 1 },
      ],
      totalAmount: mouse.price * 2 + hub.price,
      status: 'confirmed',
    },
    {
      user: rohan._id,
      items: [{ product: keyboard._id, name: keyboard.name, price: keyboard.price, quantity: 1 }],
      totalAmount: keyboard.price,
      status: 'pending',
    },
  ];
  await Order.insertMany(orders);
  console.log(`[seed] orders: ${orders.length} sample orders created`);
}

(async () => {
  await connectDb();
  await seedUsers();
  await seedProducts();
  await seedOrders();
  await disconnectDb();
  console.log('[seed] application data seed complete');
  process.exit(0);
})().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
