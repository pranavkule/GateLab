const { spawnSync } = require('child_process');
const path = require('path');
const { PRODUCTS, seedCatalogProducts } = require('../backend/scripts/catalogProducts');

describe('production catalog seed', () => {
  test('upserts only missing products without replacing existing catalog fields', async () => {
    const existing = new Set([PRODUCTS[0].name, PRODUCTS[1].name]);
    const Product = {
      updateOne: jest.fn(async (filter) => {
        if (existing.has(filter.name)) return { upsertedCount: 0 };
        existing.add(filter.name);
        return { upsertedCount: 1 };
      }),
    };

    await expect(seedCatalogProducts(Product)).resolves.toEqual({
      created: 6,
      alreadyPresent: 2,
    });

    expect(Product.updateOne).toHaveBeenCalledTimes(8);
    for (const [filter, update, options] of Product.updateOne.mock.calls) {
      const product = PRODUCTS.find((item) => item.name === filter.name);
      expect(filter).toEqual({ name: product.name });
      expect(update).toEqual({ $setOnInsert: product });
      expect(options).toEqual({ upsert: true });
    }
  });

  test('production catalog command refuses non-production execution', () => {
    const result = spawnSync(process.execPath, ['backend/scripts/seedCatalog.js'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Catalog seed is production-only');
  });
});
