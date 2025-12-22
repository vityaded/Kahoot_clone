import crypto from 'crypto';
import path from 'path';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import mime from 'mime-types';
import { saveMediaAsset } from './storage.js';

const SOUND_REGEX = /\[sound:([^\]]+)\]/gi;
const IMG_REGEX = /<img[^>]+src="([^"]+)"[^>]*>/gi;

function cleanText(value = '') {
  let text = value || '';
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/div>/gi, '\n');
  text = text.replace(SOUND_REGEX, '').replace(IMG_REGEX, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

function detectMediaRefs(fieldValue = '', mediaLookup = new Set()) {
  const refs = [];
  let match;
  SOUND_REGEX.lastIndex = 0;
  IMG_REGEX.lastIndex = 0;

  while ((match = SOUND_REGEX.exec(fieldValue))) {
    refs.push({ name: match[1], hint: 'audio' });
  }
  while ((match = IMG_REGEX.exec(fieldValue))) {
    refs.push({ name: match[1], hint: 'image' });
  }

  const trimmed = fieldValue.trim();
  if (!refs.length && trimmed && mediaLookup.has(trimmed)) {
    refs.push({ name: trimmed, hint: null });
  }

  return refs;
}

function determineMediaType(fileName, hint = null) {
  const mimeType = mime.lookup(fileName) || '';
  if (hint === 'audio' || mimeType.startsWith('audio/')) return 'audio';
  if (hint === 'image' || mimeType.startsWith('image/')) return 'image';
  if (hint === 'video' || mimeType.startsWith('video/')) return 'video';

  const ext = path.extname(fileName).toLowerCase();
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.webm', '.mkv'].includes(ext)) return 'video';
  return null;
}

function parseDbRows(result) {
  if (!result?.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const record = {};
    columns.forEach((col, idx) => {
      record[col] = row[idx];
    });
    return record;
  });
}

function pickModelFields(model) {
  const fieldNames = (model?.flds || []).map((f) => f?.name || '');
  const lowerNames = fieldNames.map((name) => name.toLowerCase());
  const expressionIdx = lowerNames.indexOf('expression');
  const clipIdx = lowerNames.indexOf('clipfile');
  return { fieldNames, expressionIdx, clipIdx };
}

function findSingleMediaMapping(cleanedFields, mediaRefs) {
  const mediaFields = mediaRefs
    .map((refs, idx) => ({ refs, idx }))
    .filter((entry) => entry.refs.length > 0);
  if (mediaFields.length !== 1) return null;

  const mediaFieldIdx = mediaFields[0].idx;
  const textFieldIdx = cleanedFields.findIndex((text, idx) => idx !== mediaFieldIdx && text);
  if (textFieldIdx === -1) return null;

  return { mediaFieldIdx, textFieldIdx };
}

async function resolveMedia(ref, zip, nameToKey, cache) {
  if (!ref?.name) return null;
  if (cache.has(ref.name)) return cache.get(ref.name);
  const mediaKey = nameToKey.get(ref.name);
  if (!mediaKey) return null;
  const file = zip.file(mediaKey);
  if (!file) return null;

  const buffer = await file.async('nodebuffer');
  const type = determineMediaType(ref.name, ref.hint);
  if (!type) return null;

  const src = await saveMediaAsset(buffer, ref.name);
  const media = { type, name: ref.name, src };
  cache.set(ref.name, media);
  return media;
}

async function mapQuestionFromNote(fieldsRaw, model, mediaRefs, resolver) {
  const cleanedFields = fieldsRaw.map((field) => cleanText(field));
  const { fieldNames, expressionIdx, clipIdx } = pickModelFields(model);

  async function resolveMediaFromField(index, hint = null) {
    const refs = mediaRefs[index] || [];
    for (const ref of refs) {
      const media = await resolver({ ...ref, hint: ref.hint || hint });
      if (media) return media;
    }
    return null;
  }

  if (expressionIdx >= 0 && clipIdx >= 0) {
    const answer = cleanedFields[expressionIdx];
    const media = await resolveMediaFromField(clipIdx, 'audio');
    if (answer) {
      return {
        prompt: 'Listen and type the sentence.',
        answer,
        media,
      };
    }
  }

  const singleMedia = findSingleMediaMapping(cleanedFields, mediaRefs);
  if (singleMedia) {
    const media = await resolveMediaFromField(singleMedia.mediaFieldIdx);
    const answer = cleanedFields[singleMedia.textFieldIdx];
    if (media && answer) {
      const prompt =
        media.type === 'audio'
          ? 'Listen and type the answer.'
          : media.type === 'video'
            ? 'Watch and answer.'
            : 'Look and answer.';
      return { prompt, answer, media };
    }
  }

  if (cleanedFields[0] && cleanedFields[1]) {
    return {
      prompt: cleanedFields[0],
      answer: cleanedFields[1],
    };
  }

  return null;
}

async function importApkg(buffer, originalFileName = 'upload.apkg') {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const zip = await JSZip.loadAsync(buffer);
  const collectionEntry = zip.file('collection.anki2');
  if (!collectionEntry) {
    throw new Error('Missing collection.anki2');
  }

  const mediaEntry = zip.file('media');
  const mediaJson = mediaEntry ? await mediaEntry.async('string') : '{}';
  const mediaMap = JSON.parse(mediaJson || '{}');
  const nameToKey = new Map();
  Object.entries(mediaMap).forEach(([key, name]) => {
    if (name) nameToKey.set(name, key);
  });

  const SQL = await initSqlJs();
  const db = new SQL.Database(await collectionEntry.async('uint8array'));

  const colResult = db.exec('SELECT models, decks FROM col LIMIT 1');
  const colRows = parseDbRows(colResult);
  const colRow = colRows[0] || {};
  const models = colRow.models ? JSON.parse(colRow.models) : {};
  const decks = colRow.decks ? JSON.parse(colRow.decks) : {};

  const cardsResult = db.exec(
    'SELECT n.id as nid, n.mid, n.flds, c.did FROM notes n JOIN cards c ON c.nid = n.id ORDER BY c.did, n.id;',
  );
  const cardRows = parseDbRows(cardsResult);

  const templatesMap = new Map();
  const mediaCache = new Map();

  const mediaLookup = new Set(Array.from(nameToKey.keys()));

  for (const row of cardRows) {
    const deckId = String(row.did);
    const noteId = String(row.nid);
    const modelId = String(row.mid);
    const model = models[modelId] || null;
    const fieldsRaw = String(row.flds || '').split('\u001f');

    if (!templatesMap.has(deckId)) {
      const deckName = decks?.[deckId]?.name || `Deck ${deckId}`;
      templatesMap.set(deckId, {
        deckId,
        deckName,
        questions: [],
        seenNotes: new Set(),
      });
    }

    const template = templatesMap.get(deckId);
    if (template.seenNotes.has(noteId)) continue;
    template.seenNotes.add(noteId);

    const mediaRefs = fieldsRaw.map((field) => detectMediaRefs(field, mediaLookup));
    const question = await mapQuestionFromNote(fieldsRaw, model, mediaRefs, (ref) =>
      resolveMedia(ref, zip, nameToKey, mediaCache),
    );
    if (question?.prompt && question?.answer) {
      template.questions.push({
        prompt: question.prompt,
        answer: question.answer,
        alternateAnswers: [],
        partialAnswers: [],
        media: question.media || null,
      });
    }
  }

  const templates = Array.from(templatesMap.values())
    .filter((entry) => entry.deckName !== 'Default' && entry.questions.length)
    .map((entry) => ({
      deckId: entry.deckId,
      deckName: entry.deckName,
      questions: entry.questions,
    }));

  return {
    templates,
    sha256,
    fileName: originalFileName,
  };
}

export default importApkg;
