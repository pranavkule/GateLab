const {
  validateTestMongoUri,
  validateTestRedisUrl,
} = require('./testTargetSafety');

describe('disposable Jest target validation', () => {
  test('accepts only the dedicated local replica-set test database', () => {
    const uri = 'mongodb://127.0.0.1:27019/edgegate_test?directConnection=true';
    expect(validateTestMongoUri(uri)).toBe(uri);
  });

  test.each([
    'mongodb://127.0.0.1:27018/edgegate_test?directConnection=true',
    'mongodb://127.0.0.1:27019/edgegate?directConnection=true',
    'mongodb://127.0.0.1:27019/edgegate_test',
    'mongodb://db.example.test:27019/edgegate_test?directConnection=true',
    'mongodb+srv://cluster.example.test/edgegate_test?directConnection=true',
    'mongodb://user:password@127.0.0.1:27019/edgegate_test?directConnection=true',
  ])('rejects unsafe MongoDB target %s', (uri) => {
    expect(() => validateTestMongoUri(uri)).toThrow();
  });

  test('accepts only the dedicated local Redis test service', () => {
    const url = 'redis://127.0.0.1:6381/0';
    expect(validateTestRedisUrl(url)).toBe(url);
  });

  test.each([
    'redis://localhost:6380/0',
    'redis://127.0.0.1:6381/1',
    'redis://cache.example.test:6381/0',
    'redis://:password@127.0.0.1:6381/0',
    'rediss://127.0.0.1:6381/0',
  ])('rejects unsafe Redis target %s', (url) => {
    expect(() => validateTestRedisUrl(url)).toThrow();
  });
});
