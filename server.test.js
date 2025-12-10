import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { assignments, getAssignmentById, normalizeAssignmentId } from './server.js';

let originalAssignments;

beforeEach(() => {
  originalAssignments = new Map(assignments);
});

afterEach(() => {
  assignments.clear();
  for (const [key, value] of originalAssignments) {
    assignments.set(key, value);
  }
});

test('normalizeAssignmentId strips non-alphanumeric characters and uppercases', () => {
  assert.equal(normalizeAssignmentId('  ab-12 cd  '), 'AB12CD');
  assert.equal(normalizeAssignmentId('***abc###'), 'ABC');
  assert.equal(normalizeAssignmentId(''), null);
  assert.equal(normalizeAssignmentId(undefined), null);
});

test('getAssignmentById retrieves assignments with messy input', () => {
  const sample = {
    id: 'ZZ99YY88',
    quizId: 'SAMPLE',
    quizTitle: 'Sample Quiz',
    assignmentTitle: 'Homework',
    createdAt: Date.now(),
    questions: [],
    submissions: [],
  };

  assignments.set(sample.id, sample);

  const foundLower = getAssignmentById('zz99yy88');
  const foundSpaced = getAssignmentById(' zz-99-yy-88 ');

  assert.equal(foundLower, sample);
  assert.equal(foundSpaced, sample);
});
