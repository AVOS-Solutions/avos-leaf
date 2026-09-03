import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { AvosLogoMark } from "./AvosLogoMark";
import { LogoutButton } from "./LogoutButton";
import { NavLink } from "./NavLink";

export async function Nav() {
  const user = await getCurrentUser();

  const links = [
    { href: "/documents", label: "Documents" },
    { href: "/account", label: "Account" },
  ];

  return (
    // Same visual chrome as avos-erp / avos-licensing / avos-deck — translucent blur bar, 76px
    // height, identical AVOS logo mark — so Leaf reads as part of the same product family.
    <nav className="no-print sticky top-0 z-50 border-b border-line bg-[rgba(236,238,231,0.88)] backdrop-blur-[10px]">
      <div className="mx-auto flex h-[76px] max-w-[1180px] items-center justify-between px-4 sm:px-8">
        <Link href="/documents" className="flex items-center gap-[10px] text-ink no-underline">
          <AvosLogoMark size={26} />
          <span className="mono text-[0.95rem] font-medium tracking-[0.06em]">
            AVOS <span className="text-slate font-normal">Leaf</span>
          </span>
        </Link>
        <div className="flex items-center gap-9">
          {links.map((link) => (
            <NavLink key={link.href} href={link.href} label={link.label} />
          ))}
          {user && (
            <div className="flex items-center gap-3 border-l border-line pl-6">
              <span className="mono text-xs text-slate">{user.fullName}</span>
              <LogoutButton />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
