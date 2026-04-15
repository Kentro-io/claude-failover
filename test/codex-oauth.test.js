'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getChatGPTAccountIdFromToken,
  translateAnthropicToCodexRequest
} = require('../src/adapter-codex');

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

test('extracts chatgpt account id from oauth jwt', () => {
  const token = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-123'
    }
  });

  assert.equal(getChatGPTAccountIdFromToken(token), 'acct-123');
});

test('translates anthropic body into codex responses request', () => {
  const body = {
    model: 'claude-sonnet-4-6',
    system: 'Be helpful',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
    ],
    tools: [
      {
        name: 'lookup_weather',
        description: 'Find weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } }
      }
    ],
    stream: true
  };

  const result = translateAnthropicToCodexRequest(body, 'gpt-5.4-mini');

  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.instructions, 'Be helpful');
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.input.length, 2);
  assert.equal(result.input[0].role, 'user');
  assert.equal(result.input[0].content[0].type, 'input_text');
  assert.equal(result.input[0].content[0].text, 'Hello');
  assert.equal(result.input[1].content[0].type, 'output_text');
  assert.equal(result.tools[0].name, 'lookup_weather');
});
