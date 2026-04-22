import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClientOfflineMessage, deliverOfflineMessagesToSocket } from './offlineMessageDelivery.js';

test('buildClientOfflineMessage prefers the queued full payload when present', () => {
	const message = buildClientOfflineMessage({
		message_id: 11,
		channel_id: 'dm-user-1-user-2',
		from_username: 'Alice',
		from_user_id: 1,
		message_content: 'fallback',
		created_at: 123,
		message_type: 'text',
		message_payload_json: JSON.stringify({
			id: 'msg-queued-1',
			user: 'Alice',
			userId: 'user-1',
			senderStableId: 'user-1',
			text: 'sealed hello',
			timestamp: 456,
			type: 'text',
			encrypted: true,
			iv: 'abc123',
			replyTo: 'msg-root'
		}),
		delivered: 0,
		expires_at: 999
	});

	assert.equal(message.id, 'msg-queued-1');
	assert.equal(message.userId, 'user-1');
	assert.equal(message.senderStableId, 'user-1');
	assert.equal(message.text, 'sealed hello');
	assert.equal(message.timestamp, 456);
	assert.equal(message.replyTo, 'msg-root');
	assert.equal(message.encrypted, true);
});

test('buildClientOfflineMessage falls back to legacy columns with stable sender ids', () => {
	const message = buildClientOfflineMessage({
		message_id: 7,
		channel_id: 'dm-user-2-user-5',
		from_username: 'Bob',
		from_user_id: 2,
		message_content: 'hello from fallback',
		created_at: 333,
		message_type: 'file',
		file_url: '/uploads/file.png',
		file_name: 'file.png',
		file_size: 2048,
		delivered: 0,
		expires_at: 1000
	});

	assert.equal(message.id, 'offline-7');
	assert.equal(message.userId, 'user-2');
	assert.equal(message.senderStableId, 'user-2');
	assert.equal(message.fileUrl, '/uploads/file.png');
	assert.equal(message.fileName, 'file.png');
	assert.equal(message.fileSize, 2048);
});

test('deliverOfflineMessagesToSocket groups by channel and marks numeric ids delivered', async () => {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	let deliveredIds: number[] = [];

	await deliverOfflineMessagesToSocket(
		{
			emit(event, payload) {
				emitted.push({ event, payload });
				return true;
			}
		},
		42,
		{
			getByRecipient() {
				return [
					{
						message_id: 1,
						channel_id: 'dm-user-1-user-42',
						from_username: 'Alice',
						from_user_id: 1,
						message_content: 'hello',
						created_at: 100,
						message_type: 'text',
						message_payload_json: JSON.stringify({
							id: 'msg-1',
							user: 'Alice',
							userId: 'user-1',
							senderStableId: 'user-1',
							text: 'hello',
							timestamp: 100,
							type: 'text'
						})
					},
					{
						message_id: 2,
						channel_id: 'group-1',
						from_username: 'Carol',
						from_user_id: 3,
						message_content: 'welcome',
						created_at: 200,
						message_type: 'text'
					}
				];
			},
			markDelivered(messageIds) {
				deliveredIds = messageIds;
			}
		}
	);

	assert.deepEqual(deliveredIds, [1, 2]);
	assert.equal(emitted.length, 2);

	const firstPayload = emitted[0]?.payload as { channelId: string; messages: Array<{ id: string }> };
	const secondPayload = emitted[1]?.payload as { channelId: string; messages: Array<{ id: string; userId: string }> };

	assert.equal(firstPayload.channelId, 'dm-user-1-user-42');
	assert.equal(firstPayload.messages[0]?.id, 'msg-1');
	assert.equal(secondPayload.channelId, 'group-1');
	assert.equal(secondPayload.messages[0]?.id, 'offline-2');
	assert.equal(secondPayload.messages[0]?.userId, 'user-3');
});
