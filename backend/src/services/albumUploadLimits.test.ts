import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG,
  cloneDefaultAlbumUploadLimits,
  sanitizeAlbumUploadLimitConfig
} from './albumUploadLimits.js';

test('cloneDefaultAlbumUploadLimits returns an isolated copy', () => {
  const cloned = cloneDefaultAlbumUploadLimits();
  cloned.perRoleItemsPerMinute.new = 999;
  cloned.perRoleMaxBytesPerItem.trusted = 123;
  cloned.perScopeItemsPerMinute = 77;

  assert.equal(DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleItemsPerMinute.new, 6);
  assert.equal(DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleMaxBytesPerItem.trusted, 300 * 1024 * 1024);
  assert.equal(DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perScopeItemsPerMinute, 420);
});

test('sanitizeAlbumUploadLimitConfig clamps numeric values and preserves defaults', () => {
  const sanitized = sanitizeAlbumUploadLimitConfig({
    perRoleItemsPerMinute: {
      new: 0,
      owner: 99999
    },
    perRoleMaxBytesPerItem: {
      trusted: '2048',
      moderator: -5,
      owner: ''
    },
    perScopeItemsPerMinute: 999999
  });

  assert.equal(sanitized.perRoleItemsPerMinute.new, 1);
  assert.equal(sanitized.perRoleItemsPerMinute.owner, 5000);
  assert.equal(sanitized.perRoleMaxBytesPerItem.trusted, 2048);
  assert.equal(sanitized.perRoleMaxBytesPerItem.moderator, null);
  assert.equal(sanitized.perRoleMaxBytesPerItem.owner, DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleMaxBytesPerItem.owner);
  assert.equal(sanitized.perScopeItemsPerMinute, 20000);
});

test('sanitizeAlbumUploadLimitConfig falls back to defaults for non-object input', () => {
  const sanitized = sanitizeAlbumUploadLimitConfig(null);

  assert.deepEqual(sanitized, cloneDefaultAlbumUploadLimits());
});
