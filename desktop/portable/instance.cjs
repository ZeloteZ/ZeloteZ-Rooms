const { randomBytes } = require('node:crypto');

class InstanceVerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function values(headers, name) {
  if (typeof headers?.get === 'function') {
    const value = headers.get(name);
    return value === null ? [] : [value];
  }
  return Object.entries(headers ?? {})
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => value);
}

function hasMediaType(headers, type) {
  const [value, ...duplicates] = values(headers, 'content-type');
  return Boolean(value && !duplicates.length && !value.includes(',') &&
    value.split(';', 1)[0].trim().toLowerCase() === type);
}

function hasRoomsPageHeaders(statusCode, headers) {
  const marker = values(headers, 'x-zelotez-rooms-client');
  return statusCode === 200 && hasMediaType(headers, 'text/html') &&
    marker.length === 1 && marker[0] === '1';
}

function serverOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s\\/%?#@]+\/?$/i.test(value.trim())) {
    throw new InstanceVerificationError('invalid');
  }
  try {
    const url = new URL(value);
    if (url.port === '0' || (url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Invalid origin');
    }
    return url.origin;
  } catch {
    throw new InstanceVerificationError('invalid');
  }
}

async function readDescriptor(response) {
  const encoding = response.headers.get('content-encoding');
  if (response.status !== 200 || !hasMediaType(response.headers, 'application/json') ||
      (encoding && encoding !== 'identity') || !response.body) {
    await response.body?.cancel();
    throw new InstanceVerificationError('not_rooms');
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) throw new InstanceVerificationError('not_rooms');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new InstanceVerificationError('not_rooms');
  }
}

async function verifyInstance(address, { signal } = {}) {
  const origin = serverOrigin(address);
  const nonce = randomBytes(16).toString('hex');
  const deadline = AbortSignal.timeout(8000);
  const request = {
    redirect: 'manual', credentials: 'omit', cache: 'no-store',
    headers: { 'Accept-Encoding': 'identity' },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  };
  try {
    const endpoint = new URL('/api/desktop/instance', origin);
    endpoint.searchParams.set('nonce', nonce);
    const descriptor = await readDescriptor(await fetch(endpoint, request));
    if (descriptor?.product !== 'zelotez-rooms' || descriptor.origin !== origin ||
        descriptor.nonce !== nonce || !Number.isSafeInteger(descriptor.protocol)) {
      throw new InstanceVerificationError('not_rooms');
    }
    if (descriptor.protocol !== 1) throw new InstanceVerificationError('incompatible');
    const page = await fetch(origin, { ...request, method: 'HEAD' });
    if (!hasRoomsPageHeaders(page.status, page.headers)) throw new InstanceVerificationError('not_rooms');
    return origin;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof InstanceVerificationError) throw error;
    throw new InstanceVerificationError('unreachable');
  }
}

module.exports = { hasRoomsPageHeaders, verifyInstance };
