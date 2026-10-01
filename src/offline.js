import { getDesktop } from './desktop.js';

export function initOffline(notify){
  let pending=null;const button=document.getElementById('install-app-btn');
  if(getDesktop()){if(button)button.hidden=true;return Promise.resolve({available:false,desktop:true});}
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pending=event;if(button)button.hidden=false;});
  button?.addEventListener('click',async()=>{if(!pending)return;await pending.prompt();const choice=await pending.userChoice;if(choice.outcome==='accepted'){button.hidden=true;notify('브라우저 앱 설치를 요청했습니다.');}pending=null;});
  if(!import.meta.env.PROD||!('serviceWorker' in navigator))return Promise.resolve({available:false});
  return navigator.serviceWorker.register('/sw.js').then(async registration=>{await navigator.serviceWorker.ready;return {available:true,scope:registration.scope};}).catch(()=>({available:false}));
}
