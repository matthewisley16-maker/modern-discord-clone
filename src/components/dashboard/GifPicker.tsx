import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { GifValue } from "@/convex/gif";
import { Loader2, Search, X } from "lucide-react";

const DEBOUNCE_MS = 350;

/**
 * GIF picker.
 *
 * Opens above the composer (never covering the message input), searches real
 * GIPHY results through the `gifs.search` action, shows trending GIFs when the
 * box is empty, and stays open until the user picks a GIF, presses Escape, or
 * clicks outside. Picking a GIF only stages it — sending is explicit.
 *
 * Performance: results are small preview renditions, loaded lazily, and the grid
 * infinite-scrolls a page at a time.
 */
export default function GifPicker({
  onSelect,
  onClose,
}: {
  onSelect: (gif: GifValue) => void;
  onClose: () => void;
}) {
  const searchGifs = useAction(api.gifs.search);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<GifValue[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const reqId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Debounce the search box so we don't hit the provider on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // Escape closes the picker.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Outside-click closes the picker. The composer stays fully usable because
  // there is no full-screen backdrop — only clicks outside this panel count,
  // and the GIF toggle button is ignored so it can toggle the picker itself.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest?.(".fc-gif-toggle")) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Load the first page whenever the (debounced) query changes.
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setResults([]);
    setNext(null);
    searchGifs({ query: debounced })
      .then((res) => {
        if (id !== reqId.current) return;
        setConfigured(res.configured);
        setResults(res.results);
        setNext(res.next);
        setError(res.error);
      })
      .catch((e: unknown) => {
        if (id !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Couldn't load GIFs.");
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [debounced, searchGifs]);

  const loadMore = useCallback(() => {
    if (next === null || loading || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    searchGifs({ query: debounced, offset: next })
      .then((res) => {
        if (id !== reqId.current) return;
        setResults((prev) => {
          const seen = new Set(prev.map((g) => g.id));
          return [...prev, ...res.results.filter((g) => !seen.has(g.id))];
        });
        setNext(res.next);
        if (!res.configured) setConfigured(false);
      })
      .catch(() => {})
      .finally(() => {
        if (id === reqId.current) setLoadingMore(false);
      });
  }, [next, loading, loadingMore, debounced, searchGifs]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) loadMore();
  }

  const showGrid = !loading && !error && configured && results.length > 0;

  return (
    <div className="fc-gif-picker" role="dialog" aria-label="GIF picker" ref={rootRef}>
      <div className="fc-gif-head">
        <span className="fc-gif-title">GIFs</span>
        <div className="fc-gif-search">
          <Search size={14} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIPHY"
            aria-label="Search GIFs"
            maxLength={50}
          />
          {query && (
            <button type="button" aria-label="Clear GIF search" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <button type="button" className="fc-gif-close" aria-label="Close GIF picker" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="fc-gif-scroll" ref={scrollRef} onScroll={onScroll}>
        {loading && (
          <div className="fc-gif-status">
            <Loader2 className="fc-gif-spin" size={18} /> Loading GIFs…
          </div>
        )}
        {!loading && error && <div className="fc-gif-status error">{error}</div>}
        {!loading && !error && !configured && (
          <div className="fc-gif-status">
            GIF search isn&apos;t available yet. Add a GIPHY API key to enable it.
          </div>
        )}
        {!loading && !error && configured && results.length === 0 && (
          <div className="fc-gif-status">
            {debounced ? `No GIFs found for “${debounced}”.` : "No trending GIFs right now."}
          </div>
        )}
        {showGrid && (
          <div className="fc-gif-grid">
            {results.map((g) => (
              <button
                key={g.id}
                type="button"
                className="fc-gif-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(g)}
                aria-label={g.title ? `Send ${g.title}` : "Send GIF"}
              >
                <img src={g.previewUrl} alt={g.title ?? ""} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {loadingMore && (
          <div className="fc-gif-more">
            <Loader2 className="fc-gif-spin" size={16} />
          </div>
        )}
      </div>

      <div className="fc-gif-foot">Powered by GIPHY</div>
    </div>
  );
}
