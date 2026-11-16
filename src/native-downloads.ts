import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
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

export const nativeDownloads = {
  isAvailable: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  list: read,
  async save(input: {
    url: string; title: string; titleType: string; episodeTitle: string;
    season: number; episode: number; quality: string; mimeType?: string;
    onProgress?: (percent: number) => void;
  }): Promise<SavedVideo> {
    if (!this.isAvailable()) throw new Error('Offline video downloads are available in the MaseNet Android app only.');
    const url = input.url.trim();
    if (!/^https:\/\//i.test(url)) throw new Error('The video host did not provide a secure HTTPS download link.');
    if (/\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(input.mimeType || '')) {
      throw new Error('This is an HLS streaming playlist, not a single video file. Offline HLS downloading needs a separate segment-aware download engine; this source has not been saved.');
    }
    const extension = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() || 'mp4';
    if (!['mp4','m4v','webm','mov'].includes(extension)) {
      throw new Error('This video format is not enabled for offline downloads yet. Supported files: MP4, M4V, WebM and MOV.');
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
        path, uri, size: Number(stat.size || 0), savedAt: Date.now(), mimeType: input.mimeType || (extension === 'webm' ? 'video/webm' : 'video/mp4')
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
    await Filesystem.deleteFile({ directory: Directory.Data, path: item.path });
    write(read().filter(entry => entry.id !== id));
  },
  playableUrl(item: SavedVideo) { return Capacitor.convertFileSrc(item.uri); }
};
