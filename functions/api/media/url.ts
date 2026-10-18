import { json } from "../auth/_shared";
export const onRequestGet = async ({ request }: { request: Request }) => {
 const path = new URL(request.url).searchParams.get("path") || "";
 if (!path || path.length > 512 || path.startsWith("/") || path.split("/").some(p=>p===".." || p===".")) return json({error:"Invalid media path"},400);
 return json({url:new URL("/api/media/file?path="+encodeURIComponent(path),request.url).toString()});
};