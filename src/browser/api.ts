export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export async function request<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch('/api'+path,{...init,headers:{'Content-Type':'application/json',...init?.headers}});
 const body=await response.json() as any;
 if(!response.ok)throw new ApiError(response.status,body.error?.code??'request_failed',body.error?.message??body.error?.code??'Request failed');
 return body as T;
}
