export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  addressingStyle?: 'path' | 'virtual';
}

export interface S3ObjectSummary {
  key: string;
  size: number;
  lastModified: string;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const input = typeof data === 'string' ? enc.encode(data) : data;
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return toHex(hash);
}

async function hmacRaw(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  let rawKey: Uint8Array;
  if (typeof key === 'string') {
    rawKey = enc.encode(key);
  } else if (key instanceof Uint8Array) {
    rawKey = new Uint8Array(key.byteLength);
    rawKey.set(key);
  } else {
    rawKey = new Uint8Array(key);
  }
  const keyCopy = new Uint8Array(rawKey.byteLength);
  keyCopy.set(rawKey);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyCopy.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const msgBytes = enc.encode(data);
  const msgCopy = new Uint8Array(msgBytes.byteLength);
  msgCopy.set(msgBytes);
  return globalThis.crypto.subtle.sign('HMAC', cryptoKey, msgCopy.buffer);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
}

function resolveS3Target(cfg: S3Config, objectKey: string): { targetOrigin: string; hostHeader: string; fullPath: string } {
  const cleanEndpoint = cfg.endpoint.trim().replace(/\/+$/, '');
  const base = new URL(cleanEndpoint);
  const bucket = cfg.bucket.trim();
  const keyPath = objectKey ? `/${encodeS3Path(objectKey)}` : '';
  const basePath = base.pathname.replace(/\/+$/, '');

  const hostLower = base.hostname.toLowerCase();
  const alreadyVirtual = hostLower.startsWith(`${bucket.toLowerCase()}.`);
  const needsVirtual =
    cfg.addressingStyle === 'virtual' ||
    (!cfg.addressingStyle && (hostLower.includes('aliyuncs.com') || hostLower.includes('myqcloud.com')));

  if (alreadyVirtual) {
    return {
      targetOrigin: base.origin,
      hostHeader: base.host,
      fullPath: `${basePath}${keyPath}` || '/',
    };
  }

  if (needsVirtual) {
    const portSuffix = base.port ? `:${base.port}` : '';
    const vHost = `${bucket}.${base.hostname}${portSuffix}`;
    return {
      targetOrigin: `${base.protocol}//${vHost}`,
      hostHeader: vHost,
      fullPath: `${basePath}${keyPath}` || '/',
    };
  }

  const bucketPrefix = `/${encodeRfc3986(bucket)}`;
  return {
    targetOrigin: base.origin,
    hostHeader: base.host,
    fullPath: `${basePath}${bucketPrefix}${keyPath}` || '/',
  };
}

async function signedS3Fetch(
  cfg: S3Config,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  objectKey: string,
  queryParams: Record<string, string> = {},
  body?: Uint8Array | string,
  contentType?: string
): Promise<Response> {
  const { targetOrigin, hostHeader, fullPath } = resolveS3Target(cfg, objectKey);
  const region = (cfg.region || 'auto').trim();
  const service = 's3';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const queryKeys = Object.keys(queryParams).sort();
  const canonicalQuery = queryKeys
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');

  const payloadBytes =
    typeof body === 'string' ? enc.encode(body) : body ? body : new Uint8Array(0);
  const payloadHash = await sha256Hex(payloadBytes);

  const headersToSign: Record<string, string> = {
    host: hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) {
    headersToSign['content-type'] = contentType;
  }

  const sortedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedHeaderNames.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    fullPath || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacRaw(`AWS4${cfg.secretAccessKey.trim()}`, dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, 'aws4_request');
  const sigHex = toHex(await hmacRaw(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId.trim()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sigHex}`;

  const targetUrl = `${targetOrigin}${fullPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const fetchHeaders: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization,
  };
  if (contentType) fetchHeaders['content-type'] = contentType;

  let fetchBody: ArrayBuffer | undefined;
  if (method === 'PUT' && payloadBytes.byteLength > 0) {
    const copy = new Uint8Array(payloadBytes.byteLength);
    copy.set(payloadBytes);
    fetchBody = copy.buffer;
  }

  return fetch(targetUrl, {
    method,
    headers: fetchHeaders,
    body: fetchBody,
  });
}

function parseListObjectsXml(xml: string): S3ObjectSummary[] {
  const items: S3ObjectSummary[] = [];
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const modMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
    if (keyMatch) {
      const rawKey = keyMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      items.push({
        key: rawKey,
        size: sizeMatch ? Number(sizeMatch[1]) : 0,
        lastModified: modMatch ? modMatch[1] : new Date().toISOString(),
      });
    }
  }
  return items;
}

export async function s3ListObjects(cfg: S3Config, prefix = ''): Promise<S3ObjectSummary[]> {
  const q: Record<string, string> = { 'list-type': '2', 'max-keys': '120' };
  if (prefix) q.prefix = prefix;
  const r = await signedS3Fetch(cfg, 'GET', '', q);
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`存储桶连接失败 HTTP ${r.status}: ${errText.slice(0, 140)}`);
  }
  const xml = await r.text();
  return parseListObjectsXml(xml);
}

export async function s3PutObject(
  cfg: S3Config,
  key: string,
  data: Uint8Array | string,
  contentType = 'application/octet-stream'
): Promise<void> {
  const r = await signedS3Fetch(cfg, 'PUT', key, {}, data, contentType);
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`上传至存储桶失败 HTTP ${r.status}: ${errText.slice(0, 140)}`);
  }
}

export async function s3GetObject(
  cfg: S3Config,
  key: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const r = await signedS3Fetch(cfg, 'GET', key);
  if (!r.ok) {
    throw new Error(`读取存储桶对象失败 HTTP ${r.status}`);
  }
  const ab = await r.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: r.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function s3DeleteObject(cfg: S3Config, key: string): Promise<void> {
  const r = await signedS3Fetch(cfg, 'DELETE', key);
  if (!r.ok && r.status !== 204) {
    throw new Error(`删除存储桶对象失败 HTTP ${r.status}`);
  }
}
