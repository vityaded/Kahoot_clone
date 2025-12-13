import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import initSqlJs from 'sql.js';

const FIELD_SEPARATOR = '\u001f';

async function loadDatabase(dbPath) {
  const SQL = await initSqlJs();
  const buffer = await fs.readFile(dbPath);
  return new SQL.Database(new Uint8Array(buffer));
}

function normalizeField(text = '') {
  return String(text || '').trim();
}

function parseNotes(db) {
  const results = db.exec('SELECT id, flds FROM notes');
  if (!results?.length || !results[0]?.values) return [];

  return results[0].values.map(([id, fields]) => {
    const [prompt = '', answer = '', subtitle = ''] = String(fields || '')
      .split(FIELD_SEPARATOR)
      .map(normalizeField);

    return {
      id,
      prompt,
      answer,
      subtitle,
    };
  });
}

async function parseCollection(collectionPath) {
  try {
    const db = await loadDatabase(collectionPath);
    return parseNotes(db);
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Failed to parse collection DB', collectionPath, error);
    return [];
  }
}

async function readMediaIndex(mediaPath) {
  try {
    const raw = await fs.readFile(mediaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.entries(parsed).map(([key, name]) => ({
      index: Number(key),
      name,
    }));
  } catch (error) {
    return [];
  }
}

export async function extractApkg(apkgPath, outputDir) {
  const zip = new AdmZip(apkgPath);
  await fs.mkdir(outputDir, { recursive: true });
  zip.extractAllTo(outputDir, true);

  const mediaIndex = await readMediaIndex(path.join(outputDir, 'media'));
  const mediaFiles = mediaIndex.map(({ name }) => ({
    type: name.match(/\.(mp4|mov|mkv|avi|webm)$/i)
      ? 'video'
      : name.match(/\.(mp3|wav|m4a|aac|ogg)$/i)
      ? 'audio'
      : name.match(/\.(png|jpe?g|gif|webp|svg)$/i)
      ? 'photo'
      : 'document',
    name,
    src: path.join(outputDir, name),
  }));

  const collectionPath = ['collection.anki21', 'collection.anki2']
    .map((name) => path.join(outputDir, name))
    .find((candidate) => zip.getEntries().some((entry) => entry.entryName.endsWith(path.basename(candidate))));

  const cards = collectionPath ? await parseCollection(collectionPath) : [];

  const cardsWithMedia = cards.map((card) => {
    const matchingMedia = mediaFiles.find((file) =>
      card.prompt.includes(file.name) || card.answer.includes(file.name) || card.subtitle.includes(file.name),
    );
    return matchingMedia ? { ...card, media: matchingMedia } : card;
  });

  return { cards: cardsWithMedia, mediaFiles };
}
