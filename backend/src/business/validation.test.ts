import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeBusinessData,
  sanitizeBusinessResourceCreate,
  sanitizeBusinessResourceUpdate
} from './validation.js';

test('sanitizeBusinessData drops invalid entries and normalizes legacy fields', () => {
  const sanitized = sanitizeBusinessData(
    {
      todos: [
        {
          id: 'todo-1',
          title: 'Ship cleanup',
          status: 'blocked',
          createdBy: 42,
          tags: ['alpha', ' ', 7]
        },
        {
          status: 'todo'
        }
      ],
      projects: [
        {
          description: 'missing name should be dropped'
        }
      ],
      resources: [
        {
          id: 'resource-1',
          name: 'Architecture notes',
          type: 'mystery',
          externalUrl: 'https://example.test/spec',
          tags: ['docs', '']
        }
      ],
      graphEdges: [
        {
          id: 'edge-1',
          source: 'todo-1',
          target: 'resource-1',
          type: 'invalid-type'
        },
        {
          id: 'edge-2',
          source: '',
          target: 'resource-1'
        }
      ]
    },
    'workspace-cleanup'
  );

  assert.equal(sanitized.workspaceId, 'workspace-cleanup');
  assert.equal(sanitized.todos.length, 1);
  assert.equal(sanitized.todos[0]?.status, 'scrapped');
  assert.equal(sanitized.todos[0]?.createdBy, '42');
  assert.deepEqual(sanitized.todos[0]?.tags, ['alpha']);
  assert.equal(sanitized.projects.length, 0);
  assert.equal(sanitized.resources.length, 1);
  assert.equal(sanitized.resources[0]?.type, 'file');
  assert.equal(sanitized.resources[0]?.storageType, 'external');
  assert.deepEqual(sanitized.resources[0]?.tags, ['docs']);
  assert.equal(sanitized.graphEdges.length, 1);
  assert.equal(sanitized.graphEdges[0]?.type, 'related_to');
});

test('business resource create and update preserve immutable identity fields', () => {
  const created = sanitizeBusinessResourceCreate(
    {
      id: 'wrong-id',
      createdBy: 'wrong-user',
      name: 'Source archive',
      externalUrl: 'https://example.test/archive.zip',
      visibilityType: 'role_restricted',
      minRole: 'admin'
    },
    {
      id: 'resource-1',
      createdBy: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: 100,
      updatedAt: 200
    }
  );

  assert.ok(created);
  assert.equal(created?.id, 'resource-1');
  assert.equal(created?.createdBy, 'user-1');
  assert.equal(created?.workspaceId, 'workspace-1');
  assert.equal(created?.storageType, 'external');
  assert.equal(created?.createdAt, 100);
  assert.equal(created?.updatedAt, 200);

  const updated = sanitizeBusinessResourceUpdate(
    created!,
    {
      id: 'wrong-id-2',
      createdBy: 'wrong-user-2',
      workspaceId: 'workspace-2',
      name: 'Updated archive',
      visibilityType: 'personal'
    },
    300
  );

  assert.ok(updated);
  assert.equal(updated?.id, 'resource-1');
  assert.equal(updated?.createdBy, 'user-1');
  assert.equal(updated?.workspaceId, 'workspace-1');
  assert.equal(updated?.name, 'Updated archive');
  assert.equal(updated?.visibilityType, 'personal');
  assert.equal(updated?.updatedAt, 300);
});
