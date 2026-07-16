import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../src/hmac.js';
import {
  mediaPayload,
  reactionPayload,
  TelegramApiError,
  TelegramClient,
  textPayload,
  typingPayload,
} from '../src/telegram.js';
import { forwardInbound } from '../src/inbound.js';

test('HMAC fixture matches the plugin contract', () => {
  assert.equal(
    sign('shared', Buffer.from('{"x":1}'), '1000').signature,
    '496dee52f246c54d96e5bbd7feee1a8b7515aa706fe9eaa8ffb9f8f77bd48948',
  );
});

test('HMAC verifies exact bytes and rejects whitespace changes', () => {
  const now = 2_000;
  const raw = Buffer.from('{"x": 1}\n');
  const auth = sign('secret', raw, String(now));
  assert.equal(verify('secret', raw, auth.timestamp, auth.signature, { now }), true);
  assert.equal(
    verify('secret', Buffer.from('{"x":1}\n'), auth.timestamp, auth.signature, { now }),
    false,
  );
});

test('HMAC rejects missing, malformed, wrong-secret, and stale signatures', () => {
  const raw = Buffer.from('{}');
  const auth = sign('secret', raw, '1000');
  assert.equal(verify('secret', raw, null, null, { now: 1000 }), false);
  assert.equal(verify('secret', raw, 'junk', auth.signature, { now: 1000 }), false);
  assert.equal(verify('other', raw, '1000', auth.signature, { now: 1000 }), false);
  assert.equal(verify('secret', raw, '1000', auth.signature, { now: 1301 }), false);
});

test('text payload maps replies and optional Bot API fields', () => {
  assert.deepEqual(textPayload({
    chat_id: -100,
    text: 'hello',
    reply_to: 9,
    parse_mode: 'HTML',
    disable_notification: true,
    message_thread_id: 7,
  }), {
    method: 'sendMessage',
    payload: {
      chat_id: '-100',
      text: 'hello',
      reply_parameters: { message_id: 9 },
      parse_mode: 'HTML',
      disable_notification: true,
      message_thread_id: 7,
    },
  });
});

for (const [kind, method, field] of [
  ['image', 'sendPhoto', 'photo'],
  ['photo', 'sendPhoto', 'photo'],
  ['animation', 'sendAnimation', 'animation'],
  ['gif', 'sendAnimation', 'animation'],
  ['video', 'sendVideo', 'video'],
  ['voice', 'sendVoice', 'voice'],
  ['audio', 'sendAudio', 'audio'],
  ['document', 'sendDocument', 'document'],
  ['sticker', 'sendSticker', 'sticker'],
]) {
  test(`${kind} outbound maps to ${method}`, () => {
    const out = mediaPayload({ chat_id: 1, kind, media: 'file-or-url', caption: 'caption' });
    assert.equal(out.method, method);
    assert.equal(out.payload[field], 'file-or-url');
    assert.equal(out.payload.chat_id, '1');
    if (kind === 'sticker') assert.equal(out.payload.caption, undefined);
    else assert.equal(out.payload.caption, 'caption');
  });
}

test('reaction and typing payloads use native Bot API methods', () => {
  assert.deepEqual(reactionPayload({ chat_id: 1, message_id: 2, emoji: '❤️' }), {
    method: 'setMessageReaction',
    payload: {
      chat_id: '1',
      message_id: 2,
      reaction: [{ type: 'emoji', emoji: '❤️' }],
    },
  });
  assert.deepEqual(typingPayload({ chat_id: 1 }), {
    method: 'sendChatAction',
    payload: { chat_id: '1', action: 'typing' },
  });
  assert.deepEqual(reactionPayload({ chat_id: 1, message_id: 2, emoji: '' }).payload.reaction, []);
  assert.throws(() => typingPayload({ chat_id: 1, action: 'dancing' }), /supported action/);
});

test('outbound builders require canonical media and message_id fields', () => {
  assert.throws(
    () => mediaPayload({ chat_id: 1, kind: 'image', file_id: 'FILE' }),
    /media are required/,
  );
  assert.throws(
    () => mediaPayload({ chat_id: 1, kind: 'image', url: 'https:\/\/example.test\/x.jpg' }),
    /media are required/,
  );
  assert.throws(
    () => reactionPayload({ chat_id: 1, tg_msg_id: 2, emoji: '👍' }),
    /message_id/,
  );
});

test('Telegram client sends raw JSON and returns result', async () => {
  let request;
  const client = new TelegramClient({
    token: 'TOKEN',
    apiBase: 'https://telegram.invalid',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(await client.call('sendMessage', { chat_id: 1, text: 'hi' }), { message_id: 3 });
  assert.equal(request.url, 'https://telegram.invalid/botTOKEN/sendMessage');
  assert.deepEqual(JSON.parse(request.init.body), { chat_id: 1, text: 'hi' });
});

test('Telegram client exposes safe Bot API errors', async () => {
  const client = new TelegramClient({
    token: 'TOKEN',
    fetchImpl: async () => new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  });
  await assert.rejects(() => client.call('sendMessage'), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.code, 400);
    assert.equal(error.message, 'Bad Request');
    assert.doesNotMatch(error.message, /TOKEN/);
    return true;
  });
});

test('signed forwarding uses exact body bytes and bounded retry', async () => {
  const seen = [];
  const result = await forwardInbound(
    { tg_update_id: 10, body: 'hi' },
    {
      url: 'https://luna.invalid/inbound',
      secret: 'shared',
      attempts: 2,
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        seen.push(init);
        return new Response('', { status: seen.length === 1 ? 503 : 200 });
      },
    },
  );
  assert.deepEqual(result, { ok: true, attempts: 2 });
  assert.equal(Buffer.isBuffer(seen[0].body), true);
  assert.equal(
    verify(
      'shared',
      seen[0].body,
      seen[0].headers['x-tg-timestamp'],
      seen[0].headers['x-tg-signature'],
    ),
    true,
  );
});
