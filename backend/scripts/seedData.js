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
const { PRODUCTS, seedCatalogProducts } = require('./catalogProducts');

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
  const result = await seedCatalogProducts(Product);
  console.log(`[seed] products: ${result.created} created, ${result.alreadyPresent} already present`);
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
