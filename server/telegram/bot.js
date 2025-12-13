import fs from 'fs/promises';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { extractApkg } from './apkg.js';
import {
  createDeck,
  disableDeck,
  exportStats,
  getDeck,
  getDeckByToken,
  joinDeck,
  loadState,
  resolveDeckForUser,
  rotateDeckToken,
  setLastDeck,
  setNewPerDay,
} from './storage.js';
import { endSession, flagBadCard, getActiveSession, startSession, submitAnswer } from './session.js';

async function downloadFile(bot, fileId, destination) {
  const url = await bot.getFileLink(fileId);
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, Buffer.from(buffer));
  return destination;
}

function buildDeepLink(botUsername, token) {
  return `https://t.me/${botUsername}?start=deck_${token}`;
}

function formatCard(card) {
  return [card.prompt, card.subtitle].filter(Boolean).join('\n');
}

async function sendCard(bot, chatId, card) {
  const text = formatCard(card);
  if (card.media?.type === 'photo') {
    await bot.sendPhoto(chatId, card.media.src, { caption: text });
  } else if (card.media?.type === 'audio') {
    await bot.sendAudio(chatId, card.media.src, { caption: text });
  } else if (card.media?.type === 'video') {
    await bot.sendVideo(chatId, card.media.src, { caption: text });
  } else {
    await bot.sendMessage(chatId, text || 'Ready?');
  }
}

async function sendNext(bot, chatId, card) {
  await sendCard(bot, chatId, card);
  await bot.sendMessage(chatId, 'Send your answer.');
}

function formatScoreMessage(evaluation, score) {
  const header = evaluation.isCorrect
    ? `✅ Correct! (+${evaluation.earned})`
    : evaluation.isPartial
      ? `🟡 Almost! (+${evaluation.earned})`
      : '❌ Incorrect.';
  const comparison = `Your answer: ${evaluation.playerAnswer || '—'}\nExpected: ${evaluation.correctAnswer}`;
  return `${header} Total: ${score}\n${comparison}`;
}

async function ensureDeckFromContext(chatId, deckId, adminContext) {
  const contextDeck = adminContext.get(chatId);
  const resolved = deckId || contextDeck;
  return resolved ? getDeck(resolved) : null;
}

export async function startTelegramBot() {
  const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN (or TELEGRAM_BOT_TOKEN) is required to start the Telegram bot.');
  }
  await loadState();
  const bot = new TelegramBot(token, { polling: true });
  const botInfo = await bot.getMe();
  const adminContext = new Map();

  const getDeckFromMessage = async (msg, providedToken = null) => {
    const fromToken = providedToken?.startsWith('deck_') ? providedToken.replace('deck_', '') : providedToken;
    if (fromToken) return (await getDeckByToken(fromToken)) || (await getDeck(fromToken));
    return null;
  };

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match?.[1];
    const tokenPayload = payload?.startsWith('deck_') ? payload.replace('deck_', '') : null;
    const deck = tokenPayload ? await getDeckByToken(tokenPayload) : null;
    if (deck) {
      await joinDeck(chatId, deck.id);
      await setLastDeck(chatId, deck.id);
      bot.sendMessage(chatId, `Joined deck "${deck.title}". Use /today to start your session.`);
    } else {
      bot.sendMessage(chatId, 'Welcome! Send an .apkg file to import or use your deep link to join a deck.');
    }
  });

  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const file = msg.document;
    if (!file?.file_name?.endsWith('.apkg')) return;

    const tempPath = path.join(process.cwd(), 'data', 'telegram', 'uploads', `${Date.now()}-${file.file_name}`);
    await downloadFile(bot, file.file_id, tempPath);
    const outputDir = tempPath.replace(/\.apkg$/, '');
    const { cards, mediaFiles } = await extractApkg(tempPath, outputDir);
    const deck = await createDeck({
      title: file.file_name.replace(/\.apkg$/, ''),
      cards,
      media: mediaFiles,
      mediaDir: outputDir,
    });

    adminContext.set(chatId, deck.id);
    const link = buildDeepLink(botInfo.username, deck.joinToken);
    bot.sendMessage(chatId, `Deck imported (${cards.length} cards). Students can join: ${link}`);
  });

  bot.onText(/\/rotate_link(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requested = match?.[1];
    const deck = await ensureDeckFromContext(chatId, (await getDeckFromMessage(msg, requested))?.id, adminContext);
    if (!deck) return bot.sendMessage(chatId, 'No deck selected. Upload an .apkg first.');
    const newToken = await rotateDeckToken(deck.id);
    const link = buildDeepLink(botInfo.username, newToken);
    bot.sendMessage(chatId, `New join link: ${link}`);
  });

  bot.onText(/\/set_new_per_day\s+(\d+)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const amount = match?.[1];
    const requested = match?.[2];
    const deck = await ensureDeckFromContext(chatId, (await getDeckFromMessage(msg, requested))?.id, adminContext);
    if (!deck) return bot.sendMessage(chatId, 'No deck selected.');
    const updated = await setNewPerDay(deck.id, Number(amount));
    bot.sendMessage(chatId, `Daily new card limit set to ${updated}.`);
  });

  bot.onText(/\/disable_deck(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requested = match?.[1];
    const deck = await ensureDeckFromContext(chatId, (await getDeckFromMessage(msg, requested))?.id, adminContext);
    if (!deck) return bot.sendMessage(chatId, 'No deck selected.');
    await disableDeck(deck.id);
    bot.sendMessage(chatId, 'Deck disabled.');
  });

  bot.onText(/\/export_stats(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requested = match?.[1];
    const deck = await ensureDeckFromContext(chatId, (await getDeckFromMessage(msg, requested))?.id, adminContext);
    if (!deck) return bot.sendMessage(chatId, 'No deck selected.');
    const payload = await exportStats(deck.id);
    bot.sendMessage(chatId, 'Stats:\n' + JSON.stringify(payload, null, 2));
  });

  bot.onText(/\/export_bad(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requested = match?.[1];
    const deck = await ensureDeckFromContext(chatId, (await getDeckFromMessage(msg, requested))?.id, adminContext);
    if (!deck) return bot.sendMessage(chatId, 'No deck selected.');
    const payload = await exportStats(deck.id);
    bot.sendMessage(chatId, `Flagged cards: ${payload?.badCards?.join(', ') || 'none'}`);
  });

  bot.onText(/\/today(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const tokenOrId = match?.[1];
    const deck = await resolveDeckForUser(chatId, tokenOrId);
    if (!deck) return bot.sendMessage(chatId, 'Join a deck first using the deep link.');
    await setLastDeck(chatId, deck.id);
    const session = await startSession(deck, chatId, { limit: deck.newPerDay });
    if (!session) return bot.sendMessage(chatId, 'No cards available today.');
    await sendNext(bot, chatId, session.cards[0]);
  });

  bot.on('callback_query', async (query) => {
    const { message, data, from } = query;
    if (!message || !data) return;
    if (data === 'flag_bad') {
      const session = getActiveSession(from.id);
      if (session) {
        const flaggedIndex = Math.max(0, Math.min(session.cursor - 1, session.cards.length - 1));
        const flagged = session.cards[flaggedIndex];
        if (flagged) {
          await flagBadCard(from.id, flagged.id);
        }
        await bot.answerCallbackQuery(query.id, { text: 'Card flagged and suspended.' });
      }
    }
  });

  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = getActiveSession(chatId);
    if (!session) return;

    const result = await submitAnswer(chatId, msg.text || '');
    if (!result) return;

    await bot.sendMessage(chatId, formatScoreMessage(result.evaluation, result.score), {
      reply_markup: {
        inline_keyboard: [[{ text: 'Bad card', callback_data: 'flag_bad' }]],
      },
    });

    if (result.finished) {
      endSession(chatId);
      await bot.sendMessage(chatId, `Session complete! Score: ${result.score}`);
      return;
    }

    setTimeout(() => {
      sendNext(bot, chatId, result.nextCard);
    }, 1000);
  });

  return bot;
}
