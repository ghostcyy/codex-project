import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/server-auth";
import { resolveSignedInPath } from "../../lib/auth";

export default async function RegisterPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect(resolveSignedInPath(user));
  }

  redirect("/login?create=1");
}
