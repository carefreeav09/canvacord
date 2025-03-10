// https://github.com/Brooooooklyn/canvas/blob/db81050f0f2064b4b544575db9db318ab5847d33/load-image.js

import { Readable } from 'stream';
import * as fs from 'fs';
import { CanvacordImage } from './image';
import * as fileType from 'file-type';
import { Image } from '@napi-rs/canvas';

let http: typeof import('http'), https: typeof import('https');

const MAX_REDIRECTS = 20,
  REDIRECT_STATUSES = new Set([301, 302]),
  DATA_URI = /^\s*data:/;

export type ImageSource =
  | CanvacordImage
  | Buffer
  | ArrayBuffer
  | Uint16Array
  | Uint32Array
  | Uint8Array
  | Uint8ClampedArray
  | SharedArrayBuffer
  | Readable
  | string
  | URL
  | Image;

export interface LoadImageOptions {
  headers?: Record<string, string>;
  maxRedirects?: number;
  requestOptions?: import('http').RequestOptions;
}

export async function loadImage(source: ImageSource, options: LoadImageOptions = {}) {
  // load canvacord image
  if (source instanceof CanvacordImage) return source;
  // load readable stream as image
  if (source instanceof Readable) return createImage(await consumeStream(source));
  // use the same buffer without copying if the source is a buffer
  if (Buffer.isBuffer(source)) return createImage(source);
  // construct a buffer if the source is buffer-like
  // @ts-expect-error
  if (isBufferLike(source)) return createImage(Buffer.from(source));
  // if the source is Image instance, copy the image src to new image
  if (source instanceof Image) return createImage(source.src);
  // if source is string and in data uri format, construct image using data uri
  if (typeof source === 'string' && DATA_URI.test(source)) {
    const commaIdx = source.indexOf(',');
    const encoding = source.lastIndexOf('base64', commaIdx) < 0 ? 'utf-8' : 'base64';
    const data = Buffer.from(source.slice(commaIdx + 1), encoding);
    return createImage(data);
  }
  // if source is a string or URL instance
  if (typeof source === 'string' || source instanceof URL) {
    // if the source exists as a file, construct image from that file
    if (await exists(source)) {
      return createImage(await fs.promises.readFile(source));
    } else {
      if (typeof fetch !== 'undefined') {
        return fetch(source, {
          redirect: 'follow',
          // @ts-expect-error
          headers: options.requestOptions?.headers
        }).then(async (res) => {
          if (!res.ok) throw new Error(`remote source rejected with status code ${res.status}`);
          return await createImage(Buffer.from(await res.arrayBuffer()));
        });
      }
      // the source is a remote url here
      source = source instanceof URL ? source : new URL(source);
      // attempt to download the remote source and construct image
      const data = await new Promise<Buffer>((resolve, reject) =>
        makeRequest(
          source as URL,
          resolve,
          reject,
          typeof options.maxRedirects === 'number' && options.maxRedirects >= 0 ? options.maxRedirects : MAX_REDIRECTS,
          options.requestOptions || {}
        )
      );
      return createImage(data);
    }
  }

  // throw error as don't support that source
  throw new TypeError('unsupported image source');
}

function makeRequest(
  url: URL,
  resolve: (res: Buffer) => void,
  reject: (err: unknown) => void,
  redirectCount: number,
  requestOptions: import('http').RequestOptions
) {
  const isHttps = url.protocol === 'https:';
  // lazy load the lib
  const lib: typeof import('http') = isHttps
    ? !https
      ? (https = require('https'))
      : https
    : !http
    ? (http = require('http'))
    : http;

  lib
    .get(url.toString(), requestOptions || {}, (res) => {
      const shouldRedirect = REDIRECT_STATUSES.has(res.statusCode!) && typeof res.headers.location === 'string';
      if (shouldRedirect && redirectCount > 0)
        return makeRequest(new URL(res.headers.location!), resolve, reject, redirectCount - 1, requestOptions);
      if (typeof res.statusCode === 'number' && (res.statusCode < 200 || res.statusCode >= 300)) {
        return reject(new Error(`remote source rejected with status code ${res.statusCode}`));
      }

      consumeStream(res).then(resolve, reject);
    })
    .on('error', reject);
}

function consumeStream(res: Readable) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function createImage(src: Buffer) {
  const mime = await fileType.fromBuffer(src);
  if (!mime?.mime) throw new Error('failed to load image');
  return new CanvacordImage(src, mime.mime);
}

function isBufferLike(src: ImageSource) {
  return (
    // @ts-ignore
    (src && src.type === 'Buffer') ||
    Array.isArray(src) ||
    src instanceof ArrayBuffer ||
    src instanceof SharedArrayBuffer ||
    src instanceof Object.getPrototypeOf(Uint8Array)
  );
}

async function exists(path: string | URL) {
  try {
    await fs.promises.access(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
