import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

// The bare root just routes into the app; the (app) layout and proxy enforce auth + license.
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? "/documents" : "/login");
}
