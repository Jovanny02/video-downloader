declare module 'm3u8-parser' {
  export class Parser {
    manifest: import('./hls.js').Playlist;
    push(text: string): void;
    end(): void;
  }
}
declare module 'mpd-parser' {
  export function parse(text: string, options: { manifestUri: string }): import('./hls.js').Playlist;
}
