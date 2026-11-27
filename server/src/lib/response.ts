import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ErrorCode, type ApiEnvelope } from '../../../shared/types';
import type { AppConfig } from '../config';

export class HttpApiError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string, status: ContentfulStatusCode = 400) {
    super(message);
    this.name = 'HttpApiError';
    this.code = code;
    this.status = status;
  }
}

export function ok<T>(
  c: Context,
  data: T,
  message = 'OK',
  status: ContentfulStatusCode = 200,
): Response {
  const body: ApiEnvelope<T> = {
    code: ErrorCode.OK,
    message,
    data,
  };
  return c.json(body, status);
}

export function fail(
  c: Context,
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode = 400,
  data: unknown = null,
): Response {
  const body: ApiEnvelope<unknown> = {
    code,
    message,
    data,
  };
  return c.json(body, status);
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Parses JSON body safely regardless of Content-Type (supports OpenWrt uclient-fetch)
 * and enforces strict byte-size limit.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  c: Context,
  maxBytes = 1024 * 1024,
): Promise<T> {
  const contentLengthHeader = c.req.header('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpApiError(ErrorCode.VALIDATION_ERROR, 'Request payload too large', 413);
    }
  }

  const rawText = await c.req.text();
  if (utf8Encoder.encode(rawText).byteLength > maxBytes) {
    throw new HttpApiError(ErrorCode.VALIDATION_ERROR, 'Request payload too large', 413);
  }

  if (!rawText.trim()) {
    return {} as T;
  }

  try {
    const parsed = JSON.parse(rawText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpApiError(ErrorCode.VALIDATION_ERROR, 'JSON body must be an object', 400);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof HttpApiError) throw err;
    throw new HttpApiError(ErrorCode.VALIDATION_ERROR, 'Invalid JSON body', 400);
  }
}

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(c: Context, defaultLimit = 20, maxLimit = 100): Pagination {
  const pageRaw = Number.parseInt(c.req.query('page') || '1', 10);
  const limitRaw = Number.parseInt(
    c.req.query('limit') || c.req.query('per_page') || String(defaultLimit),
    10,
  );
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, maxLimit) : defaultLimit;
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

/**
 * Escapes LIKE wildcards using '!' as the uniform SQLite/MySQL escape char.
 */
export function escapeLike(term: string): string {
  return term.replace(/[!%_]/g, '!$&');
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting multibyte chars.
 */
export function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (!input) return '';
  const bytes = utf8Encoder.encode(input);
  if (bytes.byteLength <= maxBytes) {
    return input;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return utf8Decoder.decode(bytes.subarray(0, end));
}

export function decodeBase64Utf8(b64: string): string | null {
  const clean = b64.replace(/\s+/g, '');
  if (!clean) return '';
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function getClientIp(c: Context, explicitIp?: string): string {
  if (explicitIp && explicitIp.trim()) {
    return explicitIp.trim().slice(0, 64);
  }
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp && cfIp.trim()) return cfIp.trim().slice(0, 64);
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim().slice(0, 64);
  return '';
}

export function getRequestOrigin(c: Context): string {
  const publicBaseUrl = (c.get('config') as AppConfig | undefined)?.publicBaseUrl;
  if (publicBaseUrl) {
    return publicBaseUrl;
  }
  const xfProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const xfHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = xfHost || c.req.header('host');
  try {
    const url = new URL(c.req.url);
    const proto = xfProto || url.protocol.replace(/:$/, '') || 'http';
    const finalHost = host || url.host;
    return `${proto}://${finalHost}`;
  } catch {
    return host ? `${xfProto || 'http'}://${host}` : 'http://localhost:9000';
  }
}

export function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
