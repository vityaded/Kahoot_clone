#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import importApkg from '../server/importApkg.js';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/test_import_apkg.js <path-to-file.apkg>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  const buffer = await fs.readFile(resolvedPath);
  const result = await importApkg(buffer, path.basename(resolvedPath));

  if (!result.templates?.length) {
    throw new Error('No templates were produced from the .apkg file.');
  }

  const totalQuestions = result.templates.reduce((sum, tmpl) => sum + (tmpl.questions?.length || 0), 0);
  if (totalQuestions === 0) {
    throw new Error('Templates contained no questions.');
  }

  const hasAudio = result.templates.some((tmpl) =>
    tmpl.questions?.some((q) => q.media?.type === 'audio' && q.answer),
  );

  console.log(`Import successful for ${path.basename(resolvedPath)}`);
  console.log(`Decks imported: ${result.templates.length}`);
  console.log(`Total questions: ${totalQuestions}`);
  console.log(`Contains audio-backed questions: ${hasAudio ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
