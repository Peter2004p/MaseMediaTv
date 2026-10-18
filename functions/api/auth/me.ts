import { Env, currentAdmin, json } from "./_shared";
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await currentAdmin(request, env);
  return json({ user: user ? { userId: user.id, email: user.email, provider: "google" } : null });
};
