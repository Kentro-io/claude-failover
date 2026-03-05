'use strict';

// Map of cooldown keys to expiry timestamps
// Keys are either "keyId" (blanket) or "keyId:model" (per-model)
const cooldowns = new Map();

function cooldownKey(keyId, model) {
  return model ? `${keyId}:${model}` : keyId;
}

function isInCooldown(keyId, model) {
  const now = Date.now();

  // Check blanket key-level cooldown
  const keyCD = cooldowns.get(keyId);
  if (keyCD && now < keyCD) return true;
  if (keyCD && now >= keyCD) cooldowns.delete(keyId);

  // Check key+model cooldown
  if (model) {
    const ck = cooldownKey(keyId, model);
    const modelCD = cooldowns.get(ck);
    if (modelCD && now < modelCD) return true;
    if (modelCD && now >= modelCD) cooldowns.delete(ck);
  }

  return false;
}

function setCooldown(keyId, model, retryAfterSec, defaultCooldownMs) {
  const durationMs = retryAfterSec
    ? Math.min(retryAfterSec * 1000, defaultCooldownMs || 3600000)
    : (defaultCooldownMs || 3600000);
  const until = Date.now() + durationMs;
  const ck = cooldownKey(keyId, model);
  cooldowns.set(ck, until);
  return { key: ck, until, durationMs };
}

function clearAllCooldowns() {
  cooldowns.clear();
}

function clearCooldown(keyId, model) {
  const ck = cooldownKey(keyId, model);
  cooldowns.delete(ck);
}

function getActiveCooldowns() {
  const now = Date.now();
  const active = {};
  for (const [k, until] of cooldowns.entries()) {
    if (now < until) {
      active[k] = {
        until: new Date(until).toISOString(),
        remainingMs: until - now,
        remainingMin: Math.round((until - now) / 60000)
      };
    } else {
      cooldowns.delete(k);
    }
  }
  return active;
}

module.exports = {
  isInCooldown,
  setCooldown,
  clearAllCooldowns,
  clearCooldown,
  getActiveCooldowns
};
