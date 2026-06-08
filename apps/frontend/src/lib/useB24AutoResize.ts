/**
 * useB24AutoResize — keeps the Bitrix24 application iframe sized to its
 * content so the embedded app fills the placement area instead of
 * rendering at the portal's small default height (the "opens only
 * halfway, empty space below" problem).
 *
 * Why a hook (and not a one-shot call): the app is an SPA whose content
 * height changes on route navigation, after data loads (templates,
 * deal preview), and on window resize. Sizing once at startup would be
 * stale immediately. The hook therefore re-fires the resize:
 *
 *   - on mount and on every route change (`location.pathname`),
 *   - whenever `document.body` changes size (ResizeObserver),
 *   - on window resize,
 *   - on two short delays after mount, to catch late async content
 *     (web-font swaps, the docx-preview render) that lands after the
 *     first paint.
 *
 * All firings are coalesced through a single `requestAnimationFrame`
 * so a burst of mutations triggers at most one resize message.
 *
 * `minHeight` floor: most placement views (GeneratePage, TemplatesPage)
 * use a `h-screen` + internally-scrolling layout, so their body never
 * overflows the iframe — without a floor the iframe would stay at the
 * portal's tiny default. We clamp to `max(EMBED_MIN_HEIGHT, current
 * iframe height)` so the app gets a comfortable height yet keeps any
 * larger height the portal already granted. Naturally-flowing pages
 * (SettingsPage) still grow past the floor to fit their content.
 *
 * Outside a Bitrix24 iframe (`isB24Available() === false`) the hook is a
 * no-op, so the standalone/dev experience is unaffected.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isB24Available, resizeB24WindowToContent } from './b24';

/** Comfortable minimum height (px) for viewport-pinned placement views. */
const EMBED_MIN_HEIGHT = 720;

export function useB24AutoResize(): void {
  const location = useLocation();

  useEffect(() => {
    if (!isB24Available()) return;

    let raf = 0;
    const fire = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Keep any larger height the portal already granted; never go
        // below the comfortable floor.
        const minHeight = Math.max(EMBED_MIN_HEIGHT, window.innerHeight);
        void resizeB24WindowToContent(minHeight);
      });
    };

    fire();
    // Late async content (fonts, docx-preview) lands after first paint.
    const t1 = window.setTimeout(fire, 150);
    const t2 = window.setTimeout(fire, 600);

    const observer = new ResizeObserver(fire);
    observer.observe(document.body);
    window.addEventListener('resize', fire);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      observer.disconnect();
      window.removeEventListener('resize', fire);
    };
  }, [location.pathname]);
}
