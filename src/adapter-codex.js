'use strict';

const https = require('https');
const { randomUUID } = require('crypto');
const { log } = require('./logger');

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex-Code/1.0.43';

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('');
  }
  return '';
}

function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const result = {};
  for (const key in schema) {
    if (key === 'format' && schema[key] === 'uri' && schema.type === 'string') continue;
    if (key === 'properties' && typeof schema[key] === 'object') {
      result[key] = {};
      for (const propKey in schema[key]) {
        result[key][propKey] = cleanSchema(schema[key][propKey]);
      }
    } else if ((key === 'items' || key === 'additionalProperties') && typeof schema[key] === 'object') {
      result[key] = cleanSchema(schema[key]);
    } else if (['anyOf', 'allOf', 'oneOf'].includes(key) && Array.isArray(schema[key])) {
      result[key] = schema[key].map(cleanSchema);
    } else {
      result[key] = schema[key];
    }
  }
  return result;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getChatGPTAccountIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
}

function anthropicBlockToCodexContent(blocks) {
  const text = normalizeContent(blocks);
  return [{ type: 'input_text', text }];
}

function translateAnthropicToCodexRequest(anthropicBody, targetModel) {
  const systemParts = [];
  if (typeof anthropicBody.system === 'string') {
    systemParts.push(anthropicBody.system);
  } else if (Array.isArray(anthropicBody.system)) {
    for (const block of anthropicBody.system) {
      const text = typeof block === 'string' ? block : (block.text || block.content);
      if (text) systemParts.push(typeof text === 'string' ? text : normalizeContent(text));
    }
  }

  const input = [];
  for (const msg of anthropicBody.messages || []) {
    const content = Array.isArray(msg.content)
      ? anthropicBlockToCodexContent(msg.content)
      : [{ type: 'input_text', text: typeof msg.content === 'string' ? msg.content : String(msg.content || '') }];
    input.push({ type: 'message', role: msg.role, content });
  }

  const request = {
    model: targetModel,
    instructions: systemParts.join('\n\n') || 'You are a helpful AI assistant.',
    input,
    stream: true,
    store: false,
    include: [],
    parallel_tool_calls: false,
    tool_choice: 'auto'
  };

  if (anthropicBody.tools && anthropicBody.tools.length > 0) {
    request.tools = anthropicBody.tools
      .filter(tool => tool.name !== 'BatchTool')
      .map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: cleanSchema(tool.input_schema)
      }));
    if (request.tools.length === 0) delete request.tools;
  }

  return request;
}

function sendCodexRequest(requestBody, token, accountId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(requestBody);
    const req = https.request(CODEX_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': requestBody.stream ? 'text/event-stream' : 'application/json',
        'Authorization': `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        'originator': 'codex_cli_rs',
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'User-Agent': CODEX_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'session_id': randomUUID(),
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    }, resolve);

    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Codex backend timeout (120s)')));
    req.write(body);
    req.end();
  });
}

function readResponseBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    res.on('error', reject);
  });
}

function parseCodexEventText(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'response.output_text.delta') return event.delta || '';
  if (event.type === 'response.output_item.done') {
    const contents = event.item?.content;
    if (Array.isArray(contents)) {
      return contents
        .map(item => item?.text || '')
        .filter(Boolean)
        .join('');
    }
  }
  if (event.type === 'response.completed') {
    const outputs = event.response?.output || [];
    return outputs
      .flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(item => item?.text || '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamCodexToAnthropic(codexRes, clientRes, requestModel) {
  return new Promise((resolve, reject) => {
    const messageId = 'msg_' + Math.random().toString(36).slice(2, 26);
    let buffer = '';
    let headersWritten = false;
    let blockStarted = false;
    let emittedText = false;

    const ensureHeaders = () => {
      if (headersWritten) return;
      headersWritten = true;
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      writeSSE(clientRes, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: requestModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
    };

    const emitText = (text) => {
      if (!text) return;
      ensureHeaders();
      if (!blockStarted) {
        blockStarted = true;
        writeSSE(clientRes, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        });
      }
      emittedText = true;
      writeSSE(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      });
    };

    const finalize = () => {
      ensureHeaders();
      if (!blockStarted) {
        blockStarted = true;
        writeSSE(clientRes, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        });
      }
      writeSSE(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      writeSSE(clientRes, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: emittedText ? 1 : 0 }
      });
      writeSSE(clientRes, 'message_stop', { type: 'message_stop' });
      clientRes.end();
      resolve();
    };

    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = rawEvent.split('\n').filter(line => line.startsWith('data: '));
        for (const line of dataLines) {
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload);
            const text = parseCodexEventText(event);
            if (event.type === 'response.output_text.delta') emitText(text);
            else if (event.type === 'response.output_item.done' && !emittedText) emitText(text);
          } catch (err) {
            log('warn', 'Failed to parse Codex SSE event', { error: err.message });
          }
        }
      }
    };

    codexRes.on('data', handleChunk);
    codexRes.on('end', finalize);
    codexRes.on('error', (err) => {
      log('error', 'Codex stream read error', { error: err.message });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Codex stream error: ' + err.message } }));
      }
      reject(err);
    });
  });
}

async function collectCodexText(codexRes) {
  let buffer = '';
  let text = '';
  let sawDelta = false;

  for await (const chunk of codexRes) {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = rawEvent.split('\n').filter(line => line.startsWith('data: '));
      for (const line of dataLines) {
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'response.output_text.delta') {
            sawDelta = true;
            text += event.delta || '';
          } else if (!sawDelta) {
            text += parseCodexEventText(event);
          }
        } catch {}
      }
    }
  }

  return text;
}

async function handleViaCodexOAuth(parsedBody, targetModel, token, clientRes) {
  const accountId = getChatGPTAccountIdFromToken(token);
  if (!accountId) {
    return { success: false, statusCode: 401, error: 'missing_account_id' };
  }

  const codexRequest = translateAnthropicToCodexRequest(parsedBody, targetModel);
  const codexRes = await sendCodexRequest(codexRequest, token, accountId);

  if (codexRes.statusCode === 429) {
    const retryAfter = parseInt(codexRes.headers['retry-after'], 10) || null;
    codexRes.resume();
    return { success: false, statusCode: 429, retryAfter };
  }
  if (codexRes.statusCode === 401 || codexRes.statusCode === 403) {
    const body = await readResponseBody(codexRes);
    return { success: false, statusCode: codexRes.statusCode, error: body };
  }
  if (codexRes.statusCode === 404) {
    const body = await readResponseBody(codexRes);
    return { success: false, statusCode: 404, error: body };
  }
  if (codexRes.statusCode >= 500) {
    const body = await readResponseBody(codexRes);
    return { success: false, statusCode: codexRes.statusCode, error: body };
  }
  if (codexRes.statusCode !== 200) {
    const body = await readResponseBody(codexRes);
    log('warn', 'Codex unexpected status', { status: codexRes.statusCode, body: body.slice(0, 500) });
    return { success: false, statusCode: codexRes.statusCode, error: body };
  }

  if (parsedBody.stream === true) {
    await streamCodexToAnthropic(codexRes, clientRes, parsedBody.model);
  } else {
    const text = await collectCodexText(codexRes);
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      id: 'msg_' + Math.random().toString(36).slice(2, 26),
      type: 'message',
      role: 'assistant',
      model: parsedBody.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }));
  }

  return { success: true, statusCode: 200 };
}

async function testCodexOAuthToken(token, model = 'gpt-5.4-mini') {
  const accountId = getChatGPTAccountIdFromToken(token);
  if (!accountId) {
    return { valid: false, status: 401, model, error: 'Missing chatgpt_account_id in OAuth token', code: 'missing_account_id' };
  }

  try {
    const requestBody = translateAnthropicToCodexRequest({
      model,
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: 'Hi' }]
    }, model);
    const res = await sendCodexRequest(requestBody, token, accountId);
    if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 429) {
      if (res.statusCode !== 200 && res.statusCode !== 201) res.resume();
      return {
        valid: true,
        status: res.statusCode,
        model,
        note: res.statusCode === 429 ? 'Rate limited but token is valid through Codex OAuth' : undefined
      };
    }
    const body = await readResponseBody(res);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const err = parsed?.error || parsed || {};
    return {
      valid: false,
      status: res.statusCode,
      model,
      error: err.message || body,
      code: err.code || null,
      type: err.type || null
    };
  } catch (err) {
    return { valid: false, status: 502, model, error: err.message, code: 'request_failed' };
  }
}

module.exports = {
  getChatGPTAccountIdFromToken,
  translateAnthropicToCodexRequest,
  handleViaCodexOAuth,
  testCodexOAuthToken
};
