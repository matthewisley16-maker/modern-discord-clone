import { useEffect, useMemo, useRef, useState } from "react";
import { FeatureBoundary } from "@/components/ui/feature-boundary";
import { youtubeEmbedUrl, youtubeLinksIn, youtubeThumbnail, youtubeWatchUrl, type YouTubeRef } from "@/lib/youtube";

/**
 * Lazy YouTube embed.
 *
 * Only a thumbnail is requested until the user presses play, and the whole card
 * is mounted only once it scrolls near the viewport — so a conversation with
 * many videos never loads dozens of players at once. Nothing is downloaded or
 * re-hosted; playback always happens inside YouTube's own (cookie-less) iframe.
 */
function YouTubeCard({ video }: { video: YouTubeRef }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const watch = youtubeWatchUrl(video.id, video.start);

  return (
    <div className="fc-yt" ref={ref}>
      {failed ? (
        <div className="fc-yt-fallback">
          <span>This video can&apos;t be played directly in FreeBuff.</span>
          <a href={watch} target="_blank" rel="noopener noreferrer">Open on YouTube</a>
        </div>
      ) : playing ? (
        <div className="fc-yt-frame">
          <iframe
            src={youtubeEmbedUrl(video.id, video.start)}
            title="YouTube video player"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            onError={() => setFailed(true)}
          />
        </div>
      ) : (
        <button type="button" className="fc-yt-poster" onClick={() => setPlaying(true)} aria-label="Play YouTube video in FreeBuff">
          {visible ? (
            <img src={youtubeThumbnail(video.id)} alt="" loading="lazy" onError={() => setFailed(true)} />
          ) : (
            <span className="fc-yt-skeleton" aria-hidden="true" />
          )}
          <span className="fc-yt-play" aria-hidden="true">▶</span>
          <span className="fc-yt-badge">▶ YouTube Video</span>
        </button>
      )}
      {!failed && (
        <a className="fc-yt-open" href={watch} target="_blank" rel="noopener noreferrer">
          Open on YouTube ↗
        </a>
      )}
    </div>
  );
}

/** Renders an embed for every YouTube link found in a message body. */
function YouTubeEmbedsInner({ body }: { body: string }) {
  const links = useMemo(() => youtubeLinksIn(body), [body]);
  if (links.length === 0) return null;
  return (
    <div className="fc-yt-list">
      {links.map((l) => <YouTubeCard key={l.ref.id} video={l.ref} />)}
    </div>
  );
}

/**
 * Isolated so a YouTube preview problem can never break the message list: the
 * link itself still shows as text, and the chat keeps working.
 */
export default function YouTubeEmbeds({ body }: { body: string }) {
  return (
    <FeatureBoundary fallback={null}>
      <YouTubeEmbedsInner body={body} />
    </FeatureBoundary>
  );
}
