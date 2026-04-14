'use strict';

function encodePriorityItem(provider, id) {
  return `${provider}:${id}`;
}

function decodePriorityItem(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  const idx = encoded.indexOf(':');
  if (idx <= 0) return null;
  const provider = encoded.slice(0, idx);
  const id = encoded.slice(idx + 1);
  if (!id) return null;
  if (provider !== 'anthropic' && provider !== 'openai') return null;
  return { provider, id, encoded };
}

function hasProviderKey(config, provider, id) {
  return provider === 'openai' ? Boolean(config.openaiKeys?.[id]) : Boolean(config.keys?.[id]);
}

function buildPriorityOrder(profile = {}, config = {}) {
  const seen = new Set();
  const result = [];

  const push = (provider, id) => {
    if (!id || !hasProviderKey(config, provider, id)) return;
    const encoded = encodePriorityItem(provider, id);
    if (seen.has(encoded)) return;
    seen.add(encoded);
    result.push(encoded);
  };

  if (Array.isArray(profile.priorityOrder)) {
    for (const encoded of profile.priorityOrder) {
      const item = decodePriorityItem(encoded);
      if (!item) continue;
      push(item.provider, item.id);
    }
  } else {
    for (const id of profile.keyOrder || []) push('anthropic', id);
    for (const id of profile.openaiKeyOrder || []) push('openai', id);
  }

  for (const id of Object.keys(config.keys || {})) push('anthropic', id);
  for (const id of Object.keys(config.openaiKeys || {})) push('openai', id);

  return result;
}

function splitPriorityOrder(priorityOrder = []) {
  const keyOrder = [];
  const openaiKeyOrder = [];
  const normalized = [];

  for (const encoded of priorityOrder) {
    const item = decodePriorityItem(encoded);
    if (!item) continue;
    normalized.push(item.encoded);
    if (item.provider === 'openai') openaiKeyOrder.push(item.id);
    else keyOrder.push(item.id);
  }

  return { priorityOrder: normalized, keyOrder, openaiKeyOrder };
}

function toPriorityItems(priorityOrder = [], config = {}) {
  return priorityOrder
    .map(decodePriorityItem)
    .filter(Boolean)
    .filter(item => hasProviderKey(config, item.provider, item.id))
    .map(item => ({
      encoded: item.encoded,
      provider: item.provider,
      id: item.id,
      label: item.provider === 'openai'
        ? (config.openaiKeys?.[item.id]?.label || item.id)
        : (config.keys?.[item.id]?.label || item.id)
    }));
}

module.exports = {
  encodePriorityItem,
  decodePriorityItem,
  buildPriorityOrder,
  splitPriorityOrder,
  toPriorityItems
};
