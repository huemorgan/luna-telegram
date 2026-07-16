function fullName(user) {
  if (!user) return null;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || null;
}

function chatName(chat) {
  if (!chat) return null;
  if (chat.type === 'private') return fullName(chat) || chat.username || null;
  return chat.title || chat.username || null;
}

function chatKind(type) {
  if (type === 'private') return 'dm';
  if (type === 'group' || type === 'supergroup') return 'group';
  if (type === 'channel') return 'channel';
  return 'other';
}

function fileFields(type, file, extra = {}) {
  return {
    type,
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    file_size: file.file_size ?? null,
    ...extra,
  };
}

function messageContent(message) {
  if (typeof message.text === 'string') {
    return { kind: 'text', body: message.text, media: null };
  }
  if (message.photo?.length) {
    const photo = message.photo.at(-1);
    return {
      kind: 'image',
      body: message.caption ?? '',
      media: fileFields('image', photo, { width: photo.width, height: photo.height }),
    };
  }
  for (const [field, kind] of [
    ['animation', 'animation'],
    ['video', 'video'],
    ['voice', 'voice'],
    ['audio', 'audio'],
    ['document', 'document'],
    ['sticker', 'sticker'],
    ['video_note', 'video_note'],
  ]) {
    const file = message[field];
    if (!file) continue;
    return {
      kind,
      body: message.caption ?? file.emoji ?? '',
      media: fileFields(kind, file, {
        mime_type: file.mime_type ?? null,
        file_name: file.file_name ?? null,
        duration: file.duration ?? null,
        width: file.width ?? null,
        height: file.height ?? null,
        is_animated: file.is_animated ?? null,
        is_video: file.is_video ?? null,
      }),
    };
  }
  if (message.contact) {
    return {
      kind: 'contact',
      body: fullName(message.contact),
      media: { type: 'contact', ...message.contact },
    };
  }
  if (message.location) {
    return {
      kind: 'location',
      body: null,
      media: { type: 'location', ...message.location },
    };
  }
  const serviceType = [
    'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
    'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
    'channel_chat_created', 'message_auto_delete_timer_changed', 'pinned_message',
    'forum_topic_created', 'forum_topic_closed', 'forum_topic_reopened',
  ].find((field) => message[field] != null);
  if (serviceType) {
    return {
      kind: 'service',
      body: serviceType,
      media: { type: 'service', service_type: serviceType, value: message[serviceType] },
    };
  }
  return { kind: 'other', body: message.caption ?? '', media: null };
}

function addressedFlags(message, bot) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const username = bot?.username?.toLowerCase();
  let mentionedMe = false;
  let isCommand = false;

  for (const entity of entities) {
    const value = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === 'text_mention' && String(entity.user?.id) === String(bot?.id)) {
      mentionedMe = true;
    }
    if (entity.type === 'mention' && username && value.toLowerCase() === `@${username}`) {
      mentionedMe = true;
    }
    if (entity.type === 'bot_command') {
      const target = value.split('@')[1]?.toLowerCase();
      if (!target || target === username) isCommand = true;
    }
  }

  const isReplyToMe = String(message.reply_to_message?.from?.id ?? '')
    === String(bot?.id ?? '');
  return { mentioned_me: mentionedMe, is_reply_to_me: isReplyToMe, is_command: isCommand };
}

function reactionValue(reaction) {
  if (reaction.type === 'emoji') return { type: 'emoji', emoji: reaction.emoji };
  if (reaction.type === 'custom_emoji') {
    return { type: 'custom_emoji', custom_emoji_id: reaction.custom_emoji_id };
  }
  return { ...reaction };
}

function normalizeReaction(update, reaction, account) {
  const sender = reaction.user ?? reaction.actor_chat;
  const fresh = (reaction.new_reaction ?? []).map(reactionValue);
  const old = (reaction.old_reaction ?? []).map(reactionValue);
  return {
    account,
    event_type: 'reaction',
    chat_id: String(reaction.chat.id),
    chat_kind: chatKind(reaction.chat.type),
    chat_name: chatName(reaction.chat),
    sender_id: sender?.id != null ? String(sender.id) : null,
    sender_name: fullName(sender) || sender?.title || sender?.username || null,
    tg_update_id: update.update_id,
    tg_msg_id: reaction.message_id,
    reply_to_id: reaction.message_id,
    ts: new Date(reaction.date * 1000).toISOString(),
    kind: 'reaction',
    body: null,
    edited: false,
    mentioned_me: false,
    is_reply_to_me: false,
    is_command: false,
    media: null,
    reaction_emoji: fresh.find((item) => item.type === 'emoji')?.emoji ?? null,
    reaction_old: old,
    reaction_new: fresh,
    raw: update,
  };
}

export function updateType(update) {
  return [
    'message', 'edited_message', 'channel_post', 'edited_channel_post',
    'message_reaction', 'message_reaction_count', 'callback_query',
    'inline_query', 'chosen_inline_result', 'shipping_query', 'pre_checkout_query',
    'poll', 'poll_answer', 'my_chat_member', 'chat_member', 'chat_join_request',
  ].find((key) => update[key] != null) ?? 'unknown';
}

export function normalizeUpdate(update, bot = {}, account = 'default') {
  if (!Number.isSafeInteger(update?.update_id)) return null;
  if (update.message_reaction) return normalizeReaction(update, update.message_reaction, account);

  const type = updateType(update);
  const message = update[type];
  if (!['message', 'edited_message', 'channel_post', 'edited_channel_post'].includes(type)
      || !message?.chat || !Number.isSafeInteger(message.message_id)) {
    return null;
  }

  const sender = message.from ?? message.sender_chat;
  const content = messageContent(message);
  return {
    account,
    event_type: type.startsWith('edited_') ? 'edit' : 'message',
    chat_id: String(message.chat.id),
    chat_kind: chatKind(message.chat.type),
    chat_name: chatName(message.chat),
    sender_id: sender?.id != null ? String(sender.id) : null,
    sender_name: fullName(sender) || sender?.title || sender?.username || null,
    tg_update_id: update.update_id,
    tg_msg_id: message.message_id,
    reply_to_id: message.reply_to_message?.message_id ?? null,
    ts: new Date((message.edit_date ?? message.date) * 1000).toISOString(),
    kind: content.kind,
    body: content.body,
    edited: type.startsWith('edited_'),
    ...addressedFlags(message, bot),
    media: content.media,
    raw: update,
  };
}
