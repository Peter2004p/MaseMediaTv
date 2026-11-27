import { json } from "../auth/_shared";
interface Env { DB: D1Database; }
// Screenshot-review restrictions are retired. Old review records must not block access.
export const onRequestGet: PagesFunction<Env> = async () => json({ active: false, retired: true });
