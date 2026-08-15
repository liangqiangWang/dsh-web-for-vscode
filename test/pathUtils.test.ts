import './setup';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizePath } from '../src/utils/pathUtils';

test('normalizePath 在非 Windows 下保持原样', () => {
  const p = '/Users/hudi/src/file.ts';
  assert.equal(normalizePath(p), p);
});
