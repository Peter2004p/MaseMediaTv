export async function onRequestGet({env}) {
 const clientId=typeof env.GOOGLE_CLIENT_ID==="string"?env.GOOGLE_CLIENT_ID.trim():"";
 return Response.json({configured:Boolean(clientId),clientId:clientId||null},{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
