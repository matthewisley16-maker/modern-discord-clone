import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "convex/react";
import { Grid } from "@giphy/react-components";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { api } from "@/convex/_generated/api";
import { normalizeGiphy, type GifValue } from "@/convex/gif";
import { ImageUp, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 12;

/**
 * GIF picker built on the OFFICIAL GIPHY Web SDK.
 *
 * - `GiphyFetch` (`@giphy/js-fetch-api`) retrieves trending GIFs and search
 *   results; the official `Grid` (`@giphy/react-components`) renders them with
 *   infinite scrolling, a loading state and GIPHY's required attribution.
 * - The API key comes from `GIPHY_API_KEY` (server environment, surfaced to
 *   signed-in users). When it is missing the picker never crashes and no fake
 *   results are ever shown — the user is told GIPHY isn't configured and can
 *   upload a `.gif` instead.
 * - Selecting a GIF only STAGES it; the composer sends on the next Send press.
 */
export default function GifPicker({
  onSelect,
  onClose,
  onUploadGif,
}: {
  onSelect: (gif: GifValue) => void;
  onClose: () => void;
  onUploadGif?: (file: File) => void;
}) {
  const config = useQuery(api.gifConfig.giphyConfig, {});
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [width, setWidth] = useState(280);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const gf = useMemo(
    () => (config?.apiKey ? new GiphyFetch(config.apiKey) : null),
    [config?.apiKey],
  );

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

  // Outside-click closes the picker; the composer's GIF toggle is ignored so it
  // can still toggle the picker itself.
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

  // Grid needs a pixel width; keep it in sync with the (responsive) panel.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth - 20));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [config?.configured]);

  const fetchGifs = useCallback(
    (offset: number) => {
      if (!gf) return Promise.reject(new Error("GIPHY isn't configured."));
      const opts = { offset, limit: PAGE_SIZE };
      return debounced ? gf.search(debounced, opts) : gf.trending(opts);
    },
    [gf, debounced],
  );

  type GifClick = NonNullable<ComponentProps<typeof Grid>["onGifClick"]>;
  const onGifClick = useCallback<GifClick>(
    (gif, e) => {
      e.preventDefault();
      const value = normalizeGiphy(gif);
      if (!value) {
        toast.error("That GIF can't be sent.");
        return;
      }
      onSelect(value);
    },
    [onSelect],
  );

  const loadingConfig = config === undefined;
  const configured = config?.configured ?? false;

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
            disabled={!configured}
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

      <div className="fc-gif-scroll" ref={scrollRef}>
        {loadingConfig && (
          <div className="fc-gif-status">
            <Loader2 className="fc-gif-spin" size={18} /> Loading GIFs…
          </div>
        )}

        {!loadingConfig && !configured && (
          <div className="fc-gif-status fc-gif-unconfigured">
            <p>GIPHY search isn&apos;t configured yet.</p>
            {onUploadGif && (
              <button type="button" className="fc-gif-upload" onClick={() => fileRef.current?.click()}>
                <ImageUp size={15} /> Upload a GIF
              </button>
            )}
            <p className="fc-gif-hint">You can still add a GIPHY API key later — uploading a .gif keeps working either way.</p>
          </div>
        )}

        {!loadingConfig && configured && gf && (
          <Grid
            key={debounced}
            width={width}
            columns={width > 300 ? 3 : 2}
            gutter={8}
            borderRadius={9}
            fetchGifs={fetchGifs}
            onGifClick={onGifClick}
            loaderConfig={{ root: scrollRef.current ?? null }}
            noResultsMessage={debounced ? `No GIFs found for “${debounced}”.` : "No trending GIFs right now."}
          />
        )}
      </div>

      <div className="fc-gif-foot">
        {onUploadGif && (
          <button type="button" className="fc-gif-foot-upload" onClick={() => fileRef.current?.click()}>
            <ImageUp size={12} /> Upload GIF
          </button>
        )}
        <span className="fc-gif-powered">Powered by GIPHY</span>
      </div>

      {/* Uploading a GIF reuses the composer's existing staging pipeline; the
          file is only sent when the user presses Send. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/gif,.gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onUploadGif) onUploadGif(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
