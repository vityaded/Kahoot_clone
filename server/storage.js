import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');
export const HOMEWORK_FILE = path.join(DATA_DIR, 'homework.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');

async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function ensureDataDir() {
  await ensureDir(DATA_DIR);
}

export async function ensureMediaDir() {
  await ensureDir(MEDIA_DIR);
}

function sanitizeFileName(name = 'asset') {
  const baseName = path.basename(name);
  const cleaned = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const extension = path.extname(cleaned);
  const prefix = cleaned.slice(0, cleaned.length - extension.length) || 'asset';
  const randomSuffix = crypto.randomBytes(5).toString('hex');
  return `${prefix}-${randomSuffix}${extension}`;
}

export async function saveMediaAsset(buffer, originalName = 'asset') {
  await ensureMediaDir();
  const fileName = sanitizeFileName(originalName);
  const filePath = path.join(MEDIA_DIR, fileName);
  await fs.writeFile(filePath, buffer);
  return `/media/${fileName}`;
}
