import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const smokeRoot = path.join(__dirname, '..', '.payments-smoke');
const dbPath = path.join(smokeRoot, 'payments-smoke.db');

fs.mkdirSync(smokeRoot, { recursive: true });
if (fs.existsSync(dbPath)) {
  fs.rmSync(dbPath, { force: true });
}

process.env.DB_MODE = 'sqlite';
process.env.DATABASE_PATH = dbPath;

let closeDatabaseFn: (() => void) | undefined;

try {
  const dbModule = await import('../src/db/database.js');
  const repoModule = await import('../src/db/repositories/paymentRepository.js');
  const accessPolicyModule = await import('../src/payments/accessPolicy.js');
  const userBlocksModule = await import('../src/payments/userBlocks.js');

  dbModule.initializeDatabase();
  closeDatabaseFn = dbModule.closeDatabase;
  const db = dbModule.default;

  const paymentRepository = repoModule.paymentRepository;
  const idempotencyKey = 'smoke-create-intent-001';
  const createdAt = Date.now();
  const insertUser = db
    .prepare(
      'INSERT INTO users (username, handle, password_hash, created_at, color, is_active) VALUES (?, ?, ?, ?, ?, 1)'
    )
    .run('smoke-user', 'smokeuser', 'not-used-in-smoke', createdAt, '#445566');
  const createdByUserId = Number(insertUser.lastInsertRowid || 1);
  const savedPolicy = accessPolicyModule.savePaymentAccessPolicy({
    enabled: true,
    allowGuest: false,
    allowedRoleNames: ['member', 'admin']
  });
  if (!savedPolicy.enabled || savedPolicy.allowGuest || !savedPolicy.allowedRoleNames.includes('member')) {
    throw new Error('payment access policy save/read check failed');
  }

  const memberAllowed = accessPolicyModule.isRoleAllowedToCreatePayment(savedPolicy, ['member']);
  const guestAllowed = accessPolicyModule.isRoleAllowedToCreatePayment(savedPolicy, ['guest']);
  if (!memberAllowed || guestAllowed) {
    throw new Error('payment role policy evaluation failed');
  }

  const block = userBlocksModule.upsertPaymentUserBlock({
    userId: createdByUserId,
    blockedByUserId: createdByUserId,
    reason: 'smoke-policy-block'
  });
  if (!block) {
    throw new Error('failed to create payment user block');
  }
  const activeBlock = userBlocksModule.getActivePaymentUserBlock(createdByUserId);
  if (!activeBlock || activeBlock.reason !== 'smoke-policy-block') {
    throw new Error('payment user block lookup failed');
  }
  const clearedBlock = userBlocksModule.clearPaymentUserBlock(createdByUserId);
  if (!clearedBlock) {
    throw new Error('payment user block clear failed');
  }

  const created = paymentRepository.createIntent({
    workspaceId: 'default-workspace',
    createdByUserId,
    channelId: null,
    pluginId: 'smoke-payments',
    providerName: 'Smoke Provider',
    amountMinor: 4200,
    currency: 'usd',
    countryCode: 'us',
    checkoutMode: 'payment_link',
    idempotencyKey,
    description: 'smoke intent'
  });

  const reused = paymentRepository.createIntent({
    workspaceId: 'default-workspace',
    createdByUserId,
    channelId: null,
    pluginId: 'smoke-payments',
    providerName: 'Smoke Provider',
    amountMinor: 4200,
    currency: 'USD',
    countryCode: 'US',
    checkoutMode: 'payment_link',
    idempotencyKey,
    description: 'smoke intent'
  });

  if (created.intent_id !== reused.intent_id) {
    throw new Error('idempotency check failed: createIntent returned a different intent_id');
  }

  paymentRepository.setProviderIntentId(created.intent_id, 'provider_intent_smoke_001');
  paymentRepository.updatePresentation(created.intent_id, 'qr', {
    mode: 'qr',
    qrData: '00020101021229370016A0000006770101120115010753600410263180053037645802TH5909WABI SMOKE6007BANGKOK6304E2CA'
  });
  paymentRepository.setStatus(created.intent_id, 'pending', {
    metadata: { source: 'smoke' }
  });

  paymentRepository.addEvent(created.intent_id, {
    eventId: 'evt-smoke-001',
    eventType: 'intent.created',
    status: 'pending',
    source: 'plugin',
    payload: { step: 'create' },
    idempotencyKey: 'evt-smoke-key-001'
  });

  paymentRepository.addEvent(created.intent_id, {
    eventId: 'evt-smoke-001',
    eventType: 'intent.created',
    status: 'pending',
    source: 'plugin',
    payload: { step: 'create' },
    idempotencyKey: 'evt-smoke-key-001'
  });

  const duplicateEvent = paymentRepository.findEventByEventId('evt-smoke-001');
  if (!duplicateEvent) {
    throw new Error('event lookup failed after insert');
  }

  const eventRows = paymentRepository.listEvents(created.intent_id, 10);
  if (eventRows.length !== 1) {
    throw new Error(`event idempotency failed: expected 1 event, found ${eventRows.length}`);
  }

  paymentRepository.setStatus(created.intent_id, 'succeeded', {
    metadata: { source: 'smoke', terminal: true }
  });

  const finalIntent = paymentRepository.findViewByIntentId(created.intent_id);
  if (!finalIntent) {
    throw new Error('final intent lookup failed');
  }
  if (finalIntent.status !== 'succeeded') {
    throw new Error(`status transition failed: expected succeeded, found ${finalIntent.status}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        intentId: finalIntent.intent_id,
        status: finalIntent.status,
        providerIntentId: finalIntent.provider_intent_id,
        eventCount: eventRows.length,
        policyEnabled: savedPolicy.enabled,
        blockedUserCleared: clearedBlock
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('[payments-smoke-check] FAIL', error);
  process.exitCode = 1;
} finally {
  try {
    closeDatabaseFn?.();
  } catch {
    // no-op
  }
}
