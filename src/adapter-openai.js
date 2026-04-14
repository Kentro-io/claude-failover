'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { log } = require('./logger');

/**
 * OpenAI Adapter — translates between Anthropic Messages API and OpenAI Chat Completions API.
 * Handles request translation, response translation, and streaming translation.
 */

// ─── Request Translation (Anthropic → OpenAI) ───────────────────────────────

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('');
  }
  return '';
}

function translateRequest(anthropicBody, targetModel) {
  const messages = [];

  // System prompt → system message
  if (anthropicBody.system) {
    if (typeof anthropicBody.system === 'string') {
      messages.push({ role: 'system', content: anthropicBody.system });
    } else if (Array.isArray(anthropicBody.system)) {
      for (const block of anthropicBody.system) {
        const text = block.text || block.content;
        if (text) messages.push({ role: 'system', content: typeof text === 'string' ? text : normalizeContent(text) });
      }
    }
  }

  // Translate messages
  if (anthropicBody.messages) {
    for (const msg of anthropicBody.messages) {
      if (Array.isArray(msg.content)) {
        // Check for tool_use blocks (assistant messages with tool calls)
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const textBlocks = msg.content.filter(b => b.type === 'text');
        const thinkingBlocks = msg.content.filter(b => b.type === 'thinking');

        if (toolUses.length > 0) {
          // Assistant message with tool calls
          const openaiMsg = { role: 'assistant' };
          const textContent = textBlocks.map(b => b.text).join('');
          if (textContent) openaiMsg.content = textContent;
          else openaiMsg.content = null;
          openaiMsg.tool_calls = toolUses.map(tu => ({
            id: tu.id,
            type: 'function',
            function: {
              name: tu.name,
              arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input)
            }
          }));
          messages.push(openaiMsg);
        } else if (toolResults.length > 0) {
          // First push any text content as a user message
          const textContent = textBlocks.map(b => b.text).join('');
          if (textContent) {
            messages.push({ role: msg.role, content: textContent });
          }
          // Tool results → tool role messages
          for (const tr of toolResults) {
            let resultContent = '';
            if (typeof tr.content === 'string') {
              resultContent = tr.content;
            } else if (Array.isArray(tr.content)) {
              resultContent = tr.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('');
            }
            messages.push({
              role: 'tool',
              content: resultContent,
              tool_call_id: tr.tool_use_id
            });
          }
        } else {
          // Regular message with text/thinking blocks — drop thinking
          const textContent = textBlocks.map(b => b.text).join('');
          if (textContent) {
            messages.push({ role: msg.role, content: textContent });
          }
        }
      } else {
        // Simple string content
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // Build OpenAI payload
  const openaiPayload = {
    model: targetModel,
    messages,
    max_completion_tokens: anthropicBody.max_tokens,
    stream: anthropicBody.stream === true
  };

  if (anthropicBody.temperature !== undefined) {
    openaiPayload.temperature = anthropicBody.temperature;
  }

  if (anthropicBody.stop_sequences) {
    openaiPayload.stop = anthropicBody.stop_sequences;
  }

  // Translate tools
  if (anthropicBody.tools && anthropicBody.tools.length > 0) {
    openaiPayload.tools = anthropicBody.tools
      .filter(tool => tool.name !== 'BatchTool')
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: cleanSchema(tool.input_schema)
        }
      }));
    if (openaiPayload.tools.length === 0) delete openaiPayload.tools;
  }

  return openaiPayload;
}

// Remove format:'uri' from JSON schemas (some providers reject it)
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const result = {};
  for (const key in schema) {
    if (key === 'format' && schema[key] === 'uri' && schema.type === 'string') {
      continue; // drop format:'uri'
    }
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

// ─── Response Translation (OpenAI → Anthropic) ──────────────────────────────

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

function translateResponse(openaiData, requestModel) {
  const choice = openaiData.choices[0];
  const msg = choice.message;
  const stopReason = mapStopReason(choice.finish_reason);

  const content = [];
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments)
      });
    }
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const messageId = openaiData.id
    ? openaiData.id.replace('chatcmpl', 'msg')
    : 'msg_' + Math.random().toString(36).substr(2, 24);

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiData.usage?.prompt_tokens || 0,
      output_tokens: openaiData.usage?.completion_tokens || 0
    }
  };
}

// ─── Streaming Translation (OpenAI SSE → Anthropic SSE) ──────────────────────

function generateMessageId() {
  return 'msg_' + Math.random().toString(36).substr(2, 24);
}

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Sends an OpenAI streaming request and translates the response to Anthropic SSE format.
 * Returns a promise that resolves when streaming is complete.
 */
function streamOpenAIToAnthropic(openaiRes, clientRes, requestModel) {
  return new Promise((resolve, reject) => {
    const messageId = generateMessageId();
    let headersWritten = false;
    let textBlockStarted = false;
    let toolCallEncountered = false;
    const toolCallAccumulators = {}; // index → { id, name, args }
    let usage = null;
    let buffer = '';
    let contentBlockIndex = 0;

    function ensureHeaders() {
      if (headersWritten) return;
      headersWritten = true;

      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // message_start
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

      writeSSE(clientRes, 'ping', { type: 'ping' });
    }

    function finalize() {
      if (!headersWritten) {
        ensureHeaders();
      }

      // Close any open tool call blocks
      if (toolCallEncountered) {
        for (const idx in toolCallAccumulators) {
          writeSSE(clientRes, 'content_block_stop', {
            type: 'content_block_stop',
            index: parseInt(idx, 10)
          });
        }
      } else if (textBlockStarted) {
        writeSSE(clientRes, 'content_block_stop', {
          type: 'content_block_stop',
          index: 0
        });
      }

      const stopReason = toolCallEncountered ? 'tool_use' : 'end_turn';
      writeSSE(clientRes, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage
          ? { output_tokens: usage.completion_tokens || 0 }
          : { output_tokens: 0 }
      });

      writeSSE(clientRes, 'message_stop', { type: 'message_stop' });
      clientRes.end();
      resolve();
    }

    function processLine(line) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('data:')) return;

      const dataStr = trimmed.replace(/^data:\s*/, '');
      if (dataStr === '[DONE]') {
        finalize();
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        return; // skip unparseable lines
      }

      if (parsed.error) {
        log('error', 'OpenAI stream error', { error: parsed.error.message || parsed.error });
        if (!headersWritten) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: parsed.error.message || 'OpenAI stream error' }
          }));
          reject(new Error(parsed.error.message || 'OpenAI stream error'));
        }
        return;
      }

      ensureHeaders();

      if (parsed.usage) {
        usage = parsed.usage;
      }

      if (!parsed.choices || !parsed.choices[0]) return;
      const delta = parsed.choices[0].delta;
      if (!delta) return;

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          toolCallEncountered = true;
          const idx = tc.index;

          if (toolCallAccumulators[idx] === undefined) {
            // Close text block if it was open
            if (textBlockStarted && idx === 0) {
              // If text block was index 0, tool calls start at index 1
              // Actually let's track properly with contentBlockIndex
            }

            toolCallAccumulators[idx] = { id: tc.id, name: tc.function?.name, args: '' };

            writeSSE(clientRes, 'content_block_start', {
              type: 'content_block_start',
              index: textBlockStarted ? idx + 1 : idx,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || '',
                input: {}
              }
            });
          }

          const newArgs = tc.function?.arguments || '';
          if (newArgs) {
            toolCallAccumulators[idx].args += newArgs;
            writeSSE(clientRes, 'content_block_delta', {
              type: 'content_block_delta',
              index: textBlockStarted ? idx + 1 : idx,
              delta: {
                type: 'input_json_delta',
                partial_json: newArgs
              }
            });
          }
        }
      }

      // Text content
      if (delta.content) {
        if (!textBlockStarted) {
          textBlockStarted = true;
          writeSSE(clientRes, 'content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          });
        }

        writeSSE(clientRes, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta.content }
        });
      }

      // Reasoning (some providers send this) — drop or pass as text
      if (delta.reasoning) {
        if (!textBlockStarted) {
          textBlockStarted = true;
          writeSSE(clientRes, 'content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          });
        }
        // Pass reasoning as text since Anthropic clients can handle it
        writeSSE(clientRes, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta.reasoning }
        });
      }
    }

    openaiRes.setEncoding('utf8');
    openaiRes.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        processLine(line);
      }
    });

    openaiRes.on('end', () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        processLine(buffer);
      }
      if (!clientRes.writableEnded) {
        finalize();
      }
    });

    openaiRes.on('error', (err) => {
      log('error', 'OpenAI stream read error', { error: err.message });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'OpenAI stream error: ' + err.message }
        }));
      }
      reject(err);
    });
  });
}

// ─── HTTP Request to OpenAI ──────────────────────────────────────────────────

function sendOpenAIRequest(baseUrl, openaiPayload, token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/chat/completions', baseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify(openaiPayload);

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = transport.request(opts, resolve);
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('OpenAI request timeout (120s)'));
    });
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

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Handle a request via OpenAI.
 * @param {Object} parsedBody - Original Anthropic request body
 * @param {string} targetModel - OpenAI model to use
 * @param {string} baseUrl - OpenAI API base URL
 * @param {string} token - OpenAI API key or OAuth token
 * @param {http.ServerResponse} clientRes - Client response to write to
 * @returns {Promise<{success: boolean, statusCode?: number}>}
 */
async function handleViaOpenAI(parsedBody, targetModel, baseUrl, token, clientRes) {
  const openaiPayload = translateRequest(parsedBody, targetModel);
  const isStreaming = openaiPayload.stream;

  log('debug', 'OpenAI adapter: sending request', {
    model: targetModel,
    stream: isStreaming,
    messageCount: openaiPayload.messages.length
  });

  const openaiRes = await sendOpenAIRequest(baseUrl, openaiPayload, token);

  // Handle error responses from OpenAI
  if (openaiRes.statusCode === 429) {
    const retryAfter = parseInt(openaiRes.headers['retry-after'], 10) || null;
    openaiRes.resume();
    return { success: false, statusCode: 429, retryAfter };
  }

  if (openaiRes.statusCode === 401 || openaiRes.statusCode === 403) {
    openaiRes.resume();
    return { success: false, statusCode: openaiRes.statusCode };
  }

  if (openaiRes.statusCode === 404) {
    openaiRes.resume();
    return { success: false, statusCode: 404 };
  }

  if (openaiRes.statusCode >= 500) {
    openaiRes.resume();
    return { success: false, statusCode: openaiRes.statusCode };
  }

  if (openaiRes.statusCode !== 200) {
    const body = await readResponseBody(openaiRes);
    log('warn', 'OpenAI unexpected status', { status: openaiRes.statusCode, body: body.slice(0, 500) });
    openaiRes.resume();
    return { success: false, statusCode: openaiRes.statusCode };
  }

  // Success — translate and pipe response
  if (isStreaming) {
    await streamOpenAIToAnthropic(openaiRes, clientRes, parsedBody.model);
  } else {
    const body = await readResponseBody(openaiRes);
    const openaiData = JSON.parse(body);
    const anthropicResponse = translateResponse(openaiData, parsedBody.model);

    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(anthropicResponse));
  }

  return { success: true, statusCode: 200 };
}

module.exports = {
  translateRequest,
  translateResponse,
  handleViaOpenAI
};
