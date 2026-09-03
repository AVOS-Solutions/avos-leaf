import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { Nav } from "@/components/Nav";

// The gated shell: every /documents and /account route passes through here. Auth is already
// refreshed by proxy.ts; a valid session here already implies an active avos-leaf license, since
// the backend (Avos.Leaf.Api) refuses to issue a session at all without one — see AuthController.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-10 sm:px-8">{children}</main>
    </>
  );
}
