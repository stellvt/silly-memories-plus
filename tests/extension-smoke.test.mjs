import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest exposes the interceptor and load order', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generate_interceptor, 'sillyMemoriesPlusGenerateInterceptor');
  assert.equal(manifest.loading_order, 5000);
  assert.equal(manifest.js, 'index.js');
  assert.equal(manifest.css, 'style.css');
});

test('all extension-relative imports resolve', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
  for (const relativeImport of imports.filter(value => value.startsWith('.'))) {
    const target = resolve(root, relativeImport);
    await assert.doesNotReject(() => readFile(target));
  }
});

test('settings template contains every locally referenced static control', async () => {
  const [source, html] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
  ]);
  const externalIds = new Set(['extensions_settings2']);
  const ids = [...source.matchAll(/getElementById\('([^']+)'\)/g)]
    .map(match => match[1])
    .filter(id => id.startsWith('smp-') && !externalIds.has(id));
  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `Missing settings element #${id}`);
  }
});
