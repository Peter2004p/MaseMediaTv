function json(body,status=200){return Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
export async function onRequestGet({env}) {
  const clientId=typeof env.GOOGLE_CLIENT_ID==="string"?env.GOOGLE_CLIENT_ID.trim():"";
  return json({configured:Boolean(clientId),clientId:clientId||null,allowedEmail:"pb5089780@gmail.com"});
}
