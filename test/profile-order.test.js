'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPriorityOrder,
  splitPriorityOrder,
  encodePriorityItem,
  toPriorityItems
} = require('../src/profile-order');

test('buildPriorityOrder combines legacy anthropic and openai orders', () => {
  const profile = {
    keyOrder: ['jarvis', 'sarkis'],
    openaiKeyOrder: ['jarvis-gpt']
  };
  const config = {
    keys: { jarvis: {}, sarkis: {} },
    openaiKeys: { 'jarvis-gpt': {} }
  };

  assert.deepEqual(buildPriorityOrder(profile, config), [
    'anthropic:jarvis',
    'anthropic:sarkis',
    'openai:jarvis-gpt'
  ]);
});

test('buildPriorityOrder preserves explicit mixed-provider priority order', () => {
  const profile = {
    priorityOrder: ['openai:jarvis-gpt', 'anthropic:jarvis', 'anthropic:sarkis']
  };
  const config = {
    keys: { jarvis: {}, sarkis: {} },
    openaiKeys: { 'jarvis-gpt': {} }
  };

  assert.deepEqual(buildPriorityOrder(profile, config), [
    'openai:jarvis-gpt',
    'anthropic:jarvis',
    'anthropic:sarkis'
  ]);
});

test('splitPriorityOrder produces both legacy provider arrays', () => {
  const order = ['openai:jarvis-gpt', 'anthropic:jarvis', 'anthropic:sarkis'];
  assert.deepEqual(splitPriorityOrder(order), {
    priorityOrder: order,
    keyOrder: ['jarvis', 'sarkis'],
    openaiKeyOrder: ['jarvis-gpt']
  });
});

test('toPriorityItems returns labeled provider-aware items', () => {
  const order = ['openai:jarvis-gpt', 'anthropic:jarvis'];
  const config = {
    keys: { jarvis: { label: 'Jarvis Claude' } },
    openaiKeys: { 'jarvis-gpt': { label: 'jarvis-gpt' } }
  };

  assert.deepEqual(toPriorityItems(order, config), [
    { encoded: 'openai:jarvis-gpt', provider: 'openai', id: 'jarvis-gpt', label: 'jarvis-gpt' },
    { encoded: 'anthropic:jarvis', provider: 'anthropic', id: 'jarvis', label: 'Jarvis Claude' }
  ]);
});

test('encodePriorityItem prefixes provider and id', () => {
  assert.equal(encodePriorityItem('openai', 'jarvis-gpt'), 'openai:jarvis-gpt');
});
