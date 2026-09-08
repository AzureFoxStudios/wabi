import assert from 'node:assert/strict';

/** Mounted composer → real local Socket.IO server → receipt → rendered row.
 * Only the second outbound request is malformed, to exercise a real rejection.
 * The caller owns an isolated server/account; never run against live users. */
export async function runMessageDeliveryAppChecks(page) {
  const composer = page.locator('.chat-container textarea[rows="1"]');
  const button = page.locator('.chat-container .send-button');
  const acceptedText = `Local delivery proof ${crypto.randomUUID()}`;
  const rejectedText = `Local rejection proof ${crypto.randomUUID()}`;
  await composer.fill(acceptedText);
  await button.click();
  await page.waitForFunction(async text => {
    const { channelMessages } = await import('/src/lib/messageStore.ts');
    let state; channelMessages.subscribe(value => state = value)();
    const row = Object.values(state).flat().find(message => message.text === text);
    return row?.id?.startsWith('msg_') && row.clientMessageId && !row.deliveryState;
  }, acceptedText);
  const accepted = page.locator('.chat-container .message').filter({ hasText: acceptedText });
  await accepted.waitFor();
  assert.equal(await accepted.locator('.message-delivery-row').count(), 0, 'real server acceptance leaves no pending label');
  assert.equal(await composer.inputValue(), '', 'accepted handoff consumes its draft');
  await page.evaluate(async () => {
    const { getSocket } = await import('/src/lib/socketConnection.ts');
    const socket = getSocket();
    const emit = socket.emit;
    window.__deliveryAppRestore = () => { socket.emit = emit; };
    socket.emit = function(event, ...args) {
      if (event === 'message') {
        socket.emit = emit;
        return emit.call(this, event, { ...args[0], text: 7 }, ...args.slice(1));
      }
      return emit.call(this, event, ...args);
    };
  });
  try {
    await composer.fill(rejectedText);
    await button.click();
    const rejected = page.locator('.chat-container .message').filter({ hasText: rejectedText });
    await rejected.getByRole('status').filter({ hasText: 'Not sent: The message request is invalid.' }).waitFor();
    assert.equal(await accepted.locator('.message-delivery-row').count(), 0, 'rejection does not alter another accepted row');
    assert.equal(await rejected.getByRole('button', { name: /retry/i }).count(), 0, 'no fake persistence retry');
    console.log('PASS: mounted composer real-server acceptance and correlated validation rejection render correctly');
  } finally {
    await page.evaluate(() => { window.__deliveryAppRestore?.(); delete window.__deliveryAppRestore; });
  }
}
