import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';

export type SavedVideo = {
  id: string; title: string; titleType: string; episodeTitle: string;
  season: number; episode: number; quality: string; path: string;
  uri: string; size: number; savedAt: number; mimeType: string;
};
const STORAGE_KEY = 'masenet-native-video-downloads-v1';
const read = (): SavedVideo[] => {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
};
const write = (items: SavedVideo[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
const safe = (value: string) => value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'video';


async function saveHlsOffline(input: {
  url: string; episodeId: string; title: string; titleType: string; episodeTitle: string;
  season: number; episode: number; quality: string; onProgress?: (percent: number) => void;
}): Promise<SavedVideo> {
  const id = safe(input.title) + '-' + safe(String(input.season || 0) + '-' + String(input.episode || 0)) + '-' + safe(input.quality) + '-' + Date.now();
  const folder = 'masenet-downloads/' + id;
  await Filesystem.mkdir({ directory: Directory.Data, path: folder, recursive: true });
  const resources = new Map<string, string>();
  const resolveResource = (raw: string, base: string) => {
    const resolved = new URL(raw.trim(), base);
    const parent = new URL(base);
    // Some CDNs put a shared signature on the playlist URL and omit it from
    // relative segment/key URLs. Carry only missing parameters on the same host.
    if (resolved.protocol === 'https:' && parent.protocol === 'https:' && resolved.hostname === parent.hostname) {
      parent.searchParams.forEach((value, key) => {
        if (!resolved.searchParams.has(key)) resolved.searchParams.append(key, value);
      });
    }
    return resolved.toString();
  };
  let completed = 0, total = 0, totalBytes = 0;
  const fetchPlaylist = async (url: string) => {
    // Fetch playlist text with Capacitor's native downloader rather than browser
    // fetch: external HLS hosts often block WebView CORS, while native HTTP can
    // retrieve the playlist and segments directly without routing them through
    // the website proxy or its CDN-host allowlist.
    const tempPath = folder + '/playlist-' + String(Date.now()) + '-' + String(resources.size) + '.txt';
    const target = await Filesystem.getUri({ directory: Directory.Data, path: tempPath });
    try {
      await FileTransfer.downloadFile({ url, path: target.uri });
      const result = await Filesystem.readFile({ directory: Directory.Data, path: tempPath, encoding: Encoding.UTF8 });
      const text = typeof result.data === 'string' ? result.data : '';
      if (!text.trim().startsWith('#EXTM3U')) throw new Error('The video host did not return a valid HLS playlist. The link may have expired or may require a fresh URL.');
      return { text, url };
    } catch (error) {
      if (error instanceof Error && /valid HLS playlist/.test(error.message)) throw error;
      throw new Error('MaseNet could not download the HLS playlist from its video host. The link may be expired or the host may block downloads.');
    } finally {
      try { await Filesystem.deleteFile({ directory: Directory.Data, path: tempPath }); } catch {}
    }
  };
  const downloadResource = async (url: string, kind: string, byteRange?: { start: number; end: number }) => {
    const resourceKey = url + (byteRange ? '|bytes=' + byteRange.start + '-' + byteRange.end : '');
    const existing = resources.get(resourceKey);
    if (existing) return existing;
    const extension = kind === 'key' ? 'key' : kind === 'init' ? 'mp4' : (/\.m4s(?:$|[?#])/i.test(url) ? 'm4s' : /\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : 'ts');
    const path = folder + '/' + kind + '-' + String(resources.size + 1).padStart(5, '0') + '.' + extension;
    const target = await Filesystem.getUri({ directory: Directory.Data, path });
    const listener = await FileTransfer.addListener('progress', event => {
      if (event.url !== url) return;
      const current = event.contentLength ? event.bytes / event.contentLength : 0;
      input.onProgress?.(Math.min(99, Math.floor((completed + current) / Math.max(total, 1) * 100)));
    });
    try {
      await FileTransfer.downloadFile({
        url, path: target.uri, progress: true,
        ...(byteRange ? { headers: { Range: 'bytes=' + byteRange.start + '-' + byteRange.end } } : {})
      });
      const stat = await Filesystem.stat({ directory: Directory.Data, path });
      const downloadedBytes = Number(stat.size || 0);
      if (byteRange && downloadedBytes !== byteRange.end - byteRange.start + 1) {
        throw new Error('The HLS host did not return the requested byte range. This stream cannot currently be saved offline from this provider.');
      }
      totalBytes += downloadedBytes;
      resources.set(resourceKey, path.slice(folder.length + 1));
      completed++;
      input.onProgress?.(Math.min(99, Math.floor(completed / Math.max(total, 1) * 100)));
      return resources.get(resourceKey)!;
    } finally {
      await listener.remove();
    }
  };
  try {
    let current = await fetchPlaylist(input.url);
    // Resolve master playlists to the highest-bandwidth variant. Repeat for nested masters.
    for (let depth = 0; depth < 4; depth++) {
      const lines = current.text.split(/\r?\n/);
      const variants: { bandwidth: number; uri: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
          const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(lines[i])?.[1] || 0);
          const uri = lines.slice(i + 1).find(line => line.trim() && !line.trim().startsWith('#'));
          if (uri) variants.push({ bandwidth, uri: resolveResource(uri.trim(), current.url) });
        }
      }
      if (!variants.length) break;
      if (/^#EXT-X-MEDIA:TYPE=AUDIO,/im.test(current.text) || /AUDIO="[^"]+"/i.test(current.text)) {
        throw new Error('This HLS stream uses separate audio playlists. That layout is not supported by this offline download build yet.');
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      current = await fetchPlaylist(variants[0].uri);
      if (depth === 3 && current.text.includes('#EXT-X-STREAM-INF:')) throw new Error('This HLS playlist has too many nested quality levels.');
    }
    const lines = current.text.split(/\r?\n/);
    if (!lines.some(line => line.trim() === '#EXT-X-ENDLIST')) throw new Error('This is a live or unfinished HLS stream. Only completed VOD playlists can be saved offline.');
    if (lines.some(line => /^#EXT-X-KEY:.*METHOD=(SAMPLE-AES|SAMPLE-AES-CTR)/i.test(line))) throw new Error('This HLS stream uses SAMPLE-AES encryption, which is not supported for offline saving.');
    const segmentCount = lines.filter(line => line.trim() && !line.trim().startsWith('#')).length;
    const tagCount = lines.filter(line => /^#EXT-X-(?:KEY|MAP):.*?URI="/i.test(line)).length;
    total = segmentCount + tagCount;
    if (!segmentCount) throw new Error('MaseNet did not find any video segments in this HLS playlist.');
    if (total > 12000) throw new Error('This HLS stream contains too many segments to save safely on this phone.');
    const rewritten: string[] = [];
    let pendingRange: { length: number; offset?: number } | null = null;
    const previousRangeEnd = new Map<string, number>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { rewritten.push(line); continue; }
      if (/^#EXT-X-BYTERANGE:/i.test(trimmed)) {
        const spec = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i.exec(trimmed);
        if (!spec) throw new Error('MaseNet found an invalid HLS byte-range instruction.');
        pendingRange = { length: Number(spec[1]), offset: spec[2] === undefined ? undefined : Number(spec[2]) };
        continue;
      }
      if (!trimmed.startsWith('#')) {
        const resourceUrl = resolveResource(trimmed, current.url);
        let byteRange: { start: number; end: number } | undefined;
        if (pendingRange) {
          const start = pendingRange.offset ?? previousRangeEnd.get(resourceUrl) ?? 0;
          byteRange = { start, end: start + pendingRange.length - 1 };
          previousRangeEnd.set(resourceUrl, byteRange.end + 1);
          pendingRange = null;
        }
        const localName = await downloadResource(resourceUrl, 'segment', byteRange);
        rewritten.push(localName);
        continue;
      }
      const match = /^#EXT-X-(KEY|MAP):(.*?URI="([^"]+)")(.*)$/i.exec(line);
      if (match) {
        const resourceUrl = resolveResource(match[3], current.url);
        const kind = match[1].toUpperCase() === 'KEY' ? 'key' : 'init';
        const rangeSpec = /(?:^|,)BYTERANGE="(\d+)(?:@(\d+))?"/i.exec(match[2]);
        let byteRange: { start: number; end: number } | undefined;
        if (rangeSpec) {
          const start = rangeSpec[2] === undefined ? previousRangeEnd.get(resourceUrl) ?? 0 : Number(rangeSpec[2]);
          byteRange = { start, end: start + Number(rangeSpec[1]) - 1 };
          previousRangeEnd.set(resourceUrl, byteRange.end + 1);
        }
        const localName = await downloadResource(resourceUrl, kind, byteRange);
        let rewrittenTag = line.replace(match[3], localName);
        if (byteRange) rewrittenTag = rewrittenTag.replace(/,?BYTERANGE="\d+(?:@\d+)?"/i, '');
        rewritten.push(rewrittenTag);
      } else {
        rewritten.push(line);
      }
    }
    const manifestPath = folder + '/offline.m3u8';
    await Filesystem.writeFile({ directory: Directory.Data, path: manifestPath, data: rewritten.join('\n'), encoding: Encoding.UTF8 });
    const uri = (await Filesystem.getUri({ directory: Directory.Data, path: manifestPath })).uri;
    const item: SavedVideo = {
      id, title: input.title, titleType: input.titleType, episodeTitle: input.episodeTitle,
      season: input.season, episode: input.episode, quality: input.quality,
      path: manifestPath, uri, size: totalBytes, savedAt: Date.now(), mimeType: 'application/vnd.apple.mpegurl'
    };
    write([item, ...read().filter(existing => existing.id !== id)]);
    input.onProgress?.(100);
    return item;
  } catch (error) {
    try { await Filesystem.rmdir({ directory: Directory.Data, path: folder, recursive: true }); } catch {}
    throw error;
  }
}

export const nativeDownloads = {
  isAvailable: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  list: read,
  async save(input: {
    url: string; title: string; titleType: string; episodeTitle: string;
    season: number; episode: number; quality: string; mimeType?: string; episodeId?: string;
    onProgress?: (percent: number) => void;
  }): Promise<SavedVideo> {
    if (!this.isAvailable()) throw new Error('Offline video downloads are available in the MaseNet Android app only.');
    const url = input.url.trim();
    if (!/^https:\/\//i.test(url)) throw new Error('The video host did not provide a secure HTTPS download link.');
    if (/\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(input.mimeType || '')) {
      if (!input.episodeId) throw new Error('MaseNet could not identify this episode for a secure HLS download.');
      return saveHlsOffline({ ...input, url, episodeId: input.episodeId });
    }
    const pathnameExtension = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    const suppliedMime = String(input.mimeType || '').toLowerCase().split(';')[0].trim();
    const mimeExtensions: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/x-m4v': 'm4v',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-matroska': 'mkv',
      'video/matroska': 'mkv',
      'application/x-matroska': 'mkv',
    };
    const extension = pathnameExtension || mimeExtensions[suppliedMime] || 'mp4';
    if (!['mp4','m4v','webm','mov','mkv'].includes(extension)) {
      throw new Error('This video format is not enabled for offline downloads yet. Supported files: MP4, M4V, WebM, MOV and MKV.');
    }
    const id = safe(input.title) + '-' + safe(String(input.season || 0) + '-' + String(input.episode || 0)) + '-' + safe(input.quality) + '-' + Date.now();
    const path = 'masenet-downloads/' + id + '.' + extension;
    await Filesystem.mkdir({ directory: Directory.Data, path: 'masenet-downloads', recursive: true });
    const target = await Filesystem.getUri({ directory: Directory.Data, path });
    const listener = await FileTransfer.addListener('progress', event => {
      if (event.url !== url || !event.contentLength) return;
      input.onProgress?.(Math.max(0, Math.min(99, Math.round(event.bytes / event.contentLength * 100))));
    });
    try {
      await FileTransfer.downloadFile({ url, path: target.uri, progress: true });
      const stat = await Filesystem.stat({ directory: Directory.Data, path });
      const uri = (await Filesystem.getUri({ directory: Directory.Data, path })).uri;
      const item: SavedVideo = {
        id, title: input.title, titleType: input.titleType, episodeTitle: input.episodeTitle,
        season: input.season, episode: input.episode, quality: input.quality,
        path, uri, size: Number(stat.size || 0), savedAt: Date.now(), mimeType: input.mimeType || (extension === 'webm' ? 'video/webm' : extension === 'mkv' ? 'video/x-matroska' : extension === 'mov' ? 'video/quicktime' : 'video/mp4')
      };
      write([item, ...read().filter(existing => existing.id !== id)]);
      input.onProgress?.(100);
      return item;
    } catch (error) {
      try { await Filesystem.deleteFile({ directory: Directory.Data, path }); } catch {}
      throw error;
    } finally {
      await listener.remove();
    }
  },
  async remove(id: string) {
    const item = read().find(entry => entry.id === id);
    if (!item) return;
    if (item.mimeType === 'application/vnd.apple.mpegurl') {
      await Filesystem.rmdir({ directory: Directory.Data, path: item.path.slice(0, item.path.lastIndexOf('/')), recursive: true });
    } else {
      await Filesystem.deleteFile({ directory: Directory.Data, path: item.path });
    }
    write(read().filter(entry => entry.id !== id));
  },
  playableUrl(item: SavedVideo) { return Capacitor.convertFileSrc(item.uri); }
};
