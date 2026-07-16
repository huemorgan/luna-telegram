export class TelegramApiError extends Error {
  constructor(method, status, payload) {
    super(payload?.description || `Telegram ${method} failed with HTTP ${status}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.code = payload?.error_code;
    this.parameters = payload?.parameters;
  }
}

export class TelegramClient {
  constructor({ token, apiBase = 'https://api.telegram.org', timeoutMs = 30000, fetchImpl = fetch }) {
    this.baseUrl = `${apiBase.replace(/\/+$/, '')}/bot${token}`;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async call(method, payload = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TelegramApiError(method, 502, {
        description: 'Telegram API unavailable',
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramApiError(method, response.status, null);
    }
    if (!response.ok || data.ok !== true) {
      throw new TelegramApiError(method, response.status, data);
    }
    return data.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }

  setWebhook(payload) {
    return this.call('setWebhook', payload);
  }

  deleteWebhook(payload = {}) {
    return this.call('deleteWebhook', payload);
  }
}

export function textPayload(body) {
  if (!body?.chat_id || typeof body.text !== 'string' || !body.text.trim()) {
    throw new TypeError('chat_id and non-empty text are required');
  }
  return {
    method: 'sendMessage',
    payload: {
      chat_id: String(body.chat_id),
      text: body.text,
      ...(body.reply_to != null
        ? { reply_parameters: { message_id: Number(body.reply_to) } }
        : {}),
      ...(body.parse_mode ? { parse_mode: body.parse_mode } : {}),
      ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
      ...(body.disable_notification != null
        ? { disable_notification: Boolean(body.disable_notification) }
        : {}),
      ...(body.message_thread_id != null
        ? { message_thread_id: Number(body.message_thread_id) }
        : {}),
    },
  };
}

const MEDIA_METHODS = {
  image: ['sendPhoto', 'photo'],
  photo: ['sendPhoto', 'photo'],
  animation: ['sendAnimation', 'animation'],
  gif: ['sendAnimation', 'animation'],
  video: ['sendVideo', 'video'],
  voice: ['sendVoice', 'voice'],
  audio: ['sendAudio', 'audio'],
  document: ['sendDocument', 'document'],
  sticker: ['sendSticker', 'sticker'],
};

export function mediaPayload(body) {
  const pair = MEDIA_METHODS[body?.kind];
  const media = body?.media;
  if (!body?.chat_id || !pair || typeof media !== 'string' || !media.trim()) {
    throw new TypeError('chat_id, supported kind, and media are required');
  }
  const [method, field] = pair;
  return {
    method,
    payload: {
      chat_id: String(body.chat_id),
      [field]: media,
      ...(body.caption != null && body.kind !== 'sticker' ? { caption: body.caption } : {}),
      ...(body.parse_mode && body.kind !== 'sticker' ? { parse_mode: body.parse_mode } : {}),
      ...(body.reply_to != null
        ? { reply_parameters: { message_id: Number(body.reply_to) } }
        : {}),
      ...(body.disable_notification != null
        ? { disable_notification: Boolean(body.disable_notification) }
        : {}),
      ...(body.message_thread_id != null
        ? { message_thread_id: Number(body.message_thread_id) }
        : {}),
    },
  };
}

export function reactionPayload(body) {
  if (!body?.chat_id || body.message_id == null || typeof body.emoji !== 'string') {
    throw new TypeError('chat_id, message_id, and emoji are required');
  }
  return {
    method: 'setMessageReaction',
    payload: {
      chat_id: String(body.chat_id),
      message_id: Number(body.message_id),
      reaction: body.emoji ? [{ type: 'emoji', emoji: body.emoji }] : [],
      ...(body.is_big != null ? { is_big: Boolean(body.is_big) } : {}),
    },
  };
}

const CHAT_ACTIONS = new Set([
  'typing', 'upload_photo', 'record_video', 'upload_video', 'record_voice',
  'upload_voice', 'upload_document', 'choose_sticker', 'find_location',
  'record_video_note', 'upload_video_note',
]);

export function typingPayload(body) {
  const action = body?.action ?? 'typing';
  if (!body?.chat_id || !CHAT_ACTIONS.has(action)) {
    throw new TypeError('chat_id and a supported action are required');
  }
  return {
    method: 'sendChatAction',
    payload: {
      chat_id: String(body.chat_id),
      action,
      ...(body.message_thread_id != null
        ? { message_thread_id: Number(body.message_thread_id) }
        : {}),
    },
  };
}
