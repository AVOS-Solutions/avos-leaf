"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const isActive = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);

  return (
    <Link
      href={href}
      className={`text-sm no-underline transition-colors hover:text-signal-dim ${isActive ? "text-signal-dim" : "text-ink-soft"}`}
    >
      {label}
    </Link>
  );
}
