import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpdate, updateType } from '../src/normalize.js';

const BOT = { id: 999, username: 'LunaBot' };
const baseMessage = {
  message_id: 42,
  date: 1_721_125_600,
  chat: { id: 123, type: 'private', first_name: 'Roy' },
  from: { id: 123, first_name: 'Roy', username: 'roy' },
  text: 'hello',
};

test('normalizes a direct text message', () => {
  const update = { update_id: 100, message: baseMessage };
  assert.deepEqual(normalizeUpdate(update, BOT), {
    account: 'default',
    event_type: 'message',
    chat_id: '123',
    chat_kind: 'dm',
    chat_name: 'Roy',
    sender_id: '123',
    sender_name: 'Roy',
    tg_update_id: 100,
    tg_msg_id: 42,
    reply_to_id: null,
    ts: '2024-07-16T10:26:40.000Z',
    kind: 'text',
    body: 'hello',
    edited: false,
    mentioned_me: false,
    is_reply_to_me: false,
    is_command: false,
    media: null,
    raw: update,
  });
});

test('detects group mentions, bot commands, and replies to the bot', () => {
  const text = '@LunaBot /ask@LunaBot status';
  const message = {
    ...baseMessage,
    chat: { id: -1001, type: 'supergroup', title: 'Builders' },
    text,
    entities: [
      { type: 'mention', offset: 0, length: 8 },
      { type: 'bot_command', offset: 9, length: 12 },
    ],
    reply_to_message: { message_id: 41, from: { id: 999, is_bot: true } },
  };
  const out = normalizeUpdate({ update_id: 101, message }, BOT);
  assert.equal(out.chat_kind, 'group');
  assert.equal(out.chat_name, 'Builders');
  assert.equal(out.mentioned_me, true);
  assert.equal(out.is_command, true);
  assert.equal(out.is_reply_to_me, true);
  assert.equal(out.reply_to_id, 41);
});

test('does not treat another bot command as addressed to Luna', () => {
  const message = {
    ...baseMessage,
    text: '/ask@OtherBot',
    entities: [{ type: 'bot_command', offset: 0, length: 13 }],
  };
  assert.equal(normalizeUpdate({ update_id: 102, message }, BOT).is_command, false);
});

test('normalizes edits using edit_date', () => {
  const update = {
    update_id: 103,
    edited_message: { ...baseMessage, text: 'fixed', edit_date: 1_721_125_660 },
  };
  const out = normalizeUpdate(update, BOT);
  assert.equal(out.event_type, 'edit');
  assert.equal(out.edited, true);
  assert.equal(out.body, 'fixed');
  assert.equal(out.ts, '2024-07-16T10:27:40.000Z');
});

test('chooses the largest photo and preserves caption metadata', () => {
  const message = {
    ...baseMessage,
    text: undefined,
    caption: 'diagram',
    photo: [
      { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
      { file_id: 'large', file_unique_id: 'u2', width: 1280, height: 720, file_size: 5000 },
    ],
  };
  const out = normalizeUpdate({ update_id: 104, message }, BOT);
  assert.equal(out.kind, 'image');
  assert.equal(out.body, 'diagram');
  assert.deepEqual(out.media, {
    type: 'image',
    file_id: 'large',
    file_unique_id: 'u2',
    file_size: 5000,
    width: 1280,
    height: 720,
  });
});

for (const [field, kind] of [
  ['animation', 'animation'],
  ['video', 'video'],
  ['voice', 'voice'],
  ['audio', 'audio'],
  ['document', 'document'],
  ['sticker', 'sticker'],
  ['video_note', 'video_note'],
]) {
  test(`normalizes ${kind} media`, () => {
    const message = {
      ...baseMessage,
      text: undefined,
      [field]: {
        file_id: `${kind}-id`,
        file_unique_id: `${kind}-unique`,
        mime_type: 'application/octet-stream',
        duration: 5,
      },
    };
    const out = normalizeUpdate({ update_id: 200 + kind.length, message }, BOT);
    assert.equal(out.kind, kind);
    assert.equal(out.media.type, kind);
    assert.equal(out.media.file_id, `${kind}-id`);
    assert.equal(out.media.duration, 5);
  });
}

test('normalizes contacts, locations, and service messages', () => {
  const contact = normalizeUpdate({
    update_id: 300,
    message: { ...baseMessage, text: undefined, contact: { phone_number: '1', first_name: 'Ada' } },
  }, BOT);
  assert.equal(contact.kind, 'contact');
  assert.equal(contact.body, 'Ada');
  assert.deepEqual(contact.media, {
    type: 'contact',
    phone_number: '1',
    first_name: 'Ada',
  });

  const location = normalizeUpdate({
    update_id: 301,
    message: { ...baseMessage, text: undefined, location: { latitude: 1, longitude: 2 } },
  }, BOT);
  assert.equal(location.kind, 'location');
  assert.deepEqual(location.media, { type: 'location', latitude: 1, longitude: 2 });

  const service = normalizeUpdate({
    update_id: 302,
    message: { ...baseMessage, text: undefined, new_chat_title: 'Renamed' },
  }, BOT);
  assert.equal(service.kind, 'service');
  assert.equal(service.body, 'new_chat_title');
  assert.deepEqual(service.media, {
    type: 'service',
    service_type: 'new_chat_title',
    value: 'Renamed',
  });
});

test('channel and other chats remain valid with a null sender', () => {
  const channel = normalizeUpdate({
    update_id: 303,
    channel_post: {
      message_id: 8,
      date: 1_721_125_600,
      chat: { id: -1002, type: 'channel', title: 'Announcements' },
      text: 'release',
    },
  }, BOT);
  assert.equal(channel.chat_kind, 'channel');
  assert.equal(channel.sender_id, null);
  assert.equal(channel.sender_name, null);
  assert.equal(channel.kind, 'text');

  const other = normalizeUpdate({
    update_id: 304,
    message: {
      message_id: 9,
      date: 1_721_125_600,
      chat: { id: -1003, type: 'unsupported_type', title: 'Unknown' },
      text: 'captured',
    },
  }, BOT);
  assert.equal(other.chat_kind, 'other');
  assert.equal(other.sender_id, null);
  assert.equal(other.sender_name, null);
});

test('normalizes message reactions, including removals and custom emoji', () => {
  const update = {
    update_id: 400,
    message_reaction: {
      chat: { id: -1001, type: 'group', title: 'Builders' },
      message_id: 88,
      user: { id: 123, first_name: 'Roy' },
      date: 1_721_125_600,
      old_reaction: [{ type: 'emoji', emoji: '👍' }],
      new_reaction: [{ type: 'custom_emoji', custom_emoji_id: 'custom-1' }],
    },
  };
  const out = normalizeUpdate(update, BOT);
  assert.equal(out.kind, 'reaction');
  assert.equal(out.event_type, 'reaction');
  assert.equal(out.reply_to_id, 88);
  assert.equal(out.is_reply_to_me, false);
  assert.equal(out.reaction_emoji, null);
  assert.deepEqual(out.reaction_old, [{ type: 'emoji', emoji: '👍' }]);
  assert.deepEqual(out.reaction_new, [{ type: 'custom_emoji', custom_emoji_id: 'custom-1' }]);
});

test('captures unsupported updates by type but does not normalize them', () => {
  const update = { update_id: 500, callback_query: { id: 'x' } };
  assert.equal(updateType(update), 'callback_query');
  assert.equal(normalizeUpdate(update, BOT), null);
  assert.equal(normalizeUpdate({ message: baseMessage }, BOT), null);
});
