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
  let completed = 0, total = 0, totalBytes = 0;
  const fetchPlaylist = async (url: string) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('The HLS playlist could not be read (HTTP ' + response.status + '). The stream may have expired.');
    return { text: await response.text(), url: response.url || url };
  };
  const downloadResource = async (url: string, kind: string) => {
    const existing = resources.get(url);
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
      await FileTransfer.downloadFile({ url, path: target.uri, progress: true });
      const stat = await Filesystem.stat({ directory: Directory.Data, path });
      totalBytes += Number(stat.size || 0);
      resources.set(url, path.slice(folder.length + 1));
      completed++;
      input.onProgress?.(Math.min(99, Math.floor(completed / Math.max(total, 1) * 100)));
      return resources.get(url)!;
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
          if (uri) variants.push({ bandwidth, uri: new URL(uri.trim(), current.url).toString() });
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
    if (lines.some(line => /^#EXT-X-BYTERANGE:/i.test(line))) throw new Error('This HLS stream uses byte-range segments. This source layout is not supported for offline saving yet.');
    if (lines.some(line => /^#EXT-X-KEY:.*METHOD=(SAMPLE-AES|SAMPLE-AES-CTR)/i.test(line))) throw new Error('This HLS stream uses SAMPLE-AES encryption, which is not supported for offline saving.');
    const segmentUrls = lines.filter(line => line.trim() && !line.trim().startsWith('#')).map(line => new URL(line.trim(), current.url).toString());
    const tagUrls = lines.flatMap(line => {
      const match = /^#EXT-X-(?:KEY|MAP):.*?URI="([^"]+)"/i.exec(line);
      return match ? [new URL(match[1], current.url).toString()] : [];
    });
    total = segmentUrls.length + tagUrls.length;
    if (!segmentUrls.length) throw new Error('MaseNet did not find any video segments in this HLS playlist.');
    if (total > 12000) throw new Error('This HLS stream contains too many segments to save safely on this phone.');
    const rewritten: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { rewritten.push(line); continue; }
      if (!trimmed.startsWith('#')) {
        const resourceUrl = new URL(trimmed, current.url).toString();
        const localName = await downloadResource(resourceUrl, 'segment');
        rewritten.push(localName);
        continue;
      }
      const match = /^#EXT-X-(KEY|MAP):(.*?URI="([^"]+)")(.*)$/i.exec(line);
      if (match) {
        const resourceUrl = new URL(match[3], current.url).toString();
        const kind = match[1].toUpperCase() === 'KEY' ? 'key' : 'init';
        const localName = await downloadResource(resourceUrl, kind);
        rewritten.push(line.replace(match[3], localName));
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
