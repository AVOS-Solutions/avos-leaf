"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./LogoutButton";

/** The `<lg` counterpart to Nav.tsx's own always-visible-at-`lg`-and-up link row — same "server
 *  component fetches the data, a small client component owns the open/closed toggle state" split
 *  DocumentsPage/DocumentsClient and AccountPage/AccountClient already use elsewhere in this app,
 *  since useState needs a client boundary that the async Nav server component itself can't cross.
 *  Renders nothing at `lg` and up (that breakpoint gets Nav's own inline row instead) so there's
 *  never a duplicate set of links/logout button in the DOM at desktop widths. */
export function MobileNav({ links, userName }: { links: { href: string; label: string }[]; userName: string | null }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Closes on navigation — covers both an actual link click (the panel would otherwise still be
  // open, floating over the new page, once the route changes underneath it) and the browser
  // back/forward buttons, which fire no click of their own for onClick handlers to catch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the panel on navigation, not reacting to some other state
    setOpen(false);
  }, [pathname]);

  // Background scroll lock while the panel covers the screen — without this, a long documents list
  // behind the open menu keeps scrolling right along with a touch-drag on the panel itself, which
  // reads as broken on a phone in a way it never would on desktop (nothing to scroll behind a
  // dropdown there). Restored unconditionally on unmount so navigating away never leaves it stuck.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div className="lg:hidden">
      {/* 44x44 tappable area (h-11 w-11) around a small glyph, same "generous hit target, modest
         visible mark" shape as RibbonIconButton's own h-8 buttons use for a mouse — touch needs the
         bigger of the two. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-paper-dim"
      >
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          {open ? (
            <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 5 L17 17" />
              <path d="M17 5 L5 17" />
            </g>
          ) : (
            <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 6 L19 6" />
              <path d="M3 11 L19 11" />
              <path d="M3 16 L19 16" />
            </g>
          )}
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop — tap-outside-to-close, same idiom components/ui.tsx's Modal uses for its own
             overlay, positioned below the sticky nav bar (top-[76px]) so the logo/toggle button
             stay clickable/visible while the panel is open rather than getting covered themselves. */}
          <div className="no-print fixed inset-x-0 bottom-0 top-[76px] z-40 bg-ink/20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            id="mobile-nav-panel"
            className="no-print absolute inset-x-0 top-[76px] z-50 max-h-[calc(100dvh-76px)] overflow-y-auto border-b border-line bg-[rgba(236,238,231,0.98)] px-4 py-3 shadow-lg backdrop-blur-[10px] sm:px-8"
          >
            <div className="flex flex-col">
              {links.map((link) => (
                <MobileNavLink key={link.href} href={link.href} label={link.label} />
              ))}
            </div>
            {userName && (
              <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
                <span className="mono text-xs text-slate">{userName}</span>
                <LogoutButton />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MobileNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const isActive = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);

  return (
    <Link
      href={href}
      // py-3 + text-base keeps the tappable row comfortably past 44px tall even though the
      // touch target is the full-width row, not just the glyph, unlike the toggle button above.
      className={`rounded-md px-2 py-3 text-base no-underline transition-colors hover:bg-paper-dim hover:text-signal-dim ${
        isActive ? "text-signal-dim" : "text-ink-soft"
      }`}
    >
      {label}
    </Link>
  );
}
