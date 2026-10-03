import { useEffect, useRef, useState } from "react";
import { Loader2, Music, Pause, Play, Volume2 } from "lucide-react";

/**
 * Inline audio player for audio attachments.
 *
 * Audio is streamed straight from Freecord's existing Convex storage URL — no
 * external site, no new tab. Metadata (title/artist/album/artwork) is read from
 * the file's ID3v2 tags when present; otherwise the file name is shown.
 * Nothing plays until the user presses Play.
 */

type Meta = { title?: string; artist?: string; album?: string; pictureUrl?: string };

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0) return new TextDecoder("latin1").decode(bytes);
  if (encoding === 3) return new TextDecoder("utf-8").decode(bytes);
  // UTF-16 with BOM (encoding 1 = BOM, 2 = UTF-16BE)
  if (encoding === 2) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-16").decode(bytes);
}

function stripNull(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/** Minimal ID3v2.2/2.3/2.4 reader — enough for title/artist/album/artwork. */
function parseId3(buf: Uint8Array): Meta {
  if (buf.length < 10 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "ID3") return {};
  const ver = buf[3];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let pos = 10;
  const end = Math.min(buf.length, 10 + size);
  const meta: Meta = {};
  while (pos + 10 < end) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = ver >= 4
      ? ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f)
      : (buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7];
    const start = pos + 10;
    if (frameSize <= 0 || start + frameSize > end) break;
    const data = buf.subarray(start, start + frameSize);

    if (id === "TIT2") meta.title = decodeText(stripNull(data.subarray(1)), data[0]).trim();
    else if (id === "TPE1") meta.artist = decodeText(stripNull(data.subarray(1)), data[0]).trim();
    else if (id === "TALB") meta.album = decodeText(stripNull(data.subarray(1)), data[0]).trim();
    else if (id === "APIC" && !meta.pictureUrl) {
      try {
        const enc = data[0];
        let i = 1;
        while (i < data.length && data[i] !== 0) i++; // mime
        i++; // null
        i++; // picture type
        if (enc === 1 || enc === 2) { while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2; i += 2; }
        else { while (i < data.length && data[i] !== 0) i++; i++; }
        const mimeStart = 1;
        let mimeEnd = mimeStart;
        while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
        const mime = new TextDecoder("latin1").decode(data.subarray(mimeStart, mimeEnd)) || "image/jpeg";
        const blob = new Blob([data.subarray(i).slice().buffer as ArrayBuffer], { type: mime });
        meta.pictureUrl = URL.createObjectURL(blob);
      } catch { /* artwork is optional */ }
    }
    pos = start + frameSize;
  }
  return meta;
}

const metaCache = new Map<string, Meta>();

export default function AudioPlayer({
  url,
  name,
  size,
  contentType,
}: {
  url: string;
  name: string;
  size?: number;
  contentType?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [meta, setMeta] = useState<Meta>(() => metaCache.get(url) ?? {});
  const [error, setError] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);

  // Read ID3 metadata once per URL (mp3 only; other formats just show the name).
  useEffect(() => {
    if (metaCache.has(url)) { setMeta(metaCache.get(url)!); return; }
    const isMp3 = (contentType ?? "").includes("mpeg") || name.toLowerCase().endsWith(".mp3");
    if (!isMp3) return;
    let cancelled = false;
    setLoadingMeta(true);
    (async () => {
      try {
        const res = await fetch(url, { headers: { Range: "bytes=0-262143" } });
        const buf = new Uint8Array(await res.arrayBuffer());
        const parsed = parseId3(buf);
        if (!cancelled) { metaCache.set(url, parsed); setMeta(parsed); }
      } catch { /* fall back to the file name */ }
      finally { if (!cancelled) setLoadingMeta(false); }
    })();
    return () => { cancelled = true; };
  }, [url, name, contentType]);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setError("This audio format can't be played in your browser."));
    else el.pause();
  }

  const title = meta.title || name;
  const subtitle = [meta.artist, meta.album].filter(Boolean).join(" · ");

  return (
    <div className="fc-audio">
      <div className="fc-audio-art" aria-hidden="true">
        {meta.pictureUrl ? <img src={meta.pictureUrl} alt="" /> : <Music size={22} />}
      </div>
      <div className="fc-audio-body">
        <div className="fc-audio-head">
          <span className="fc-audio-title" title={name}>{title}</span>
          {loadingMeta && <Loader2 size={12} className="fc-audio-spin" />}
        </div>
        {subtitle && <p className="fc-audio-sub">{subtitle}</p>}
        {!subtitle && <p className="fc-audio-sub">{size ? `${(size / 1024 / 1024).toFixed(2)} MB` : "Audio"}</p>}

        {error ? (
          <p className="fc-audio-error">{error}</p>
        ) : (
          <>
            <div className="fc-audio-controls">
              <button type="button" className="fc-audio-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <span className="fc-audio-time">{fmt(current)}</span>
              <input
                type="range"
                className="fc-audio-seek"
                min={0}
                max={duration || 0}
                step={0.01}
                value={current}
                aria-label="Seek"
                onChange={(e) => {
                  const el = audioRef.current;
                  const t = Number(e.target.value);
                  setCurrent(t);
                  if (el) el.currentTime = t;
                }}
              />
              <span className="fc-audio-time">{fmt(duration)}</span>
              <span className="fc-audio-vol">
                <Volume2 size={14} />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  aria-label="Volume"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    if (audioRef.current) audioRef.current.volume = v;
                  }}
                />
              </span>
            </div>
          </>
        )}
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrent(0); }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onError={() => setError("This audio file couldn't be loaded.")}
        />
      </div>
    </div>
  );
}

function fmt(s: number) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
