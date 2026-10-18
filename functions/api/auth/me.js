import { json, ensureTables, currentUser } from "./_helpers.js";
export async function onRequestGet({request,env}) {
 if(!env.DB)return json({error:"Account service is not configured."},503);
 try{await ensureTables(env.DB);const user=await currentUser(env.DB,request);return json({authenticated:!!user,user:user?{id:user.id,email:user.email,createdAt:user.created_at}:null})}
 catch{return json({error:"Could not check your account session."},500)}
}
