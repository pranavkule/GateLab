require('dotenv').config();

if (process.env.NODE_ENV !== 'production') {
  console.error('Catalog seed is production-only; set NODE_ENV=production to run it.');
  process.exit(1);
}

const { connectDb, disconnectDb } = require('../db');
const { Product } = require('../models');
const { PRODUCTS, seedCatalogProducts } = require('./catalogProducts');

function safeErrorMessage(error) {
  return String(error.message || error).replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, '$1[redacted]@');
}

(async () => {
  await connectDb();
  try {
    const result = await seedCatalogProducts(Product);
    console.log(`[catalog-seed] products: ${result.created} created, ${result.alreadyPresent} already present (${PRODUCTS.length} checked)`);
  } finally {
    await disconnectDb();
  }
})().catch((error) => {
  console.error(`Catalog seed failed: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
