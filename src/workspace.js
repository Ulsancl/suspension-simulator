export function initWorkspace(){
  const sections={bench:['#test-bench','.telemetry-section','#detail-panel'],analysis:['#analysis-section','.results-panel'],experiments:['#experiment-workspace'],validation:['#engineering-validation']};
  const targets={'#test-bench':'bench','#analysis-section':'analysis','#experiment-workspace':'experiments','#engineering-validation':'validation'};
  const nav=document.querySelector('.workspace-nav');nav.setAttribute('role','tablist');
  let active='bench';
  const links=[...nav.querySelectorAll('a[href]')];
  function show(view,scroll=true){
    if(!sections[view])return;active=view;document.body.dataset.workspaceView=view;
    for(const [key,selectors] of Object.entries(sections))for(const selector of selectors){const element=document.querySelector(selector);if(element)element.hidden=key!==view;}
    for(const link of links){const selected=targets[link.hash]===view;link.setAttribute('role','tab');link.setAttribute('aria-selected',String(selected));link.tabIndex=selected?0:-1;link.classList.toggle('active',selected);}
    const link=links.find(item=>targets[item.hash]===view);if(link)history.replaceState(null,'',link.hash);
    if(scroll)window.scrollTo({top:0,behavior:'instant'});
    window.dispatchEvent(new CustomEvent('workspacechange',{detail:{view}}));
    window.dispatchEvent(new Event('resize'));
  }
  for(const link of [...links,document.querySelector('.analysis-link')].filter(Boolean))link.addEventListener('click',event=>{event.preventDefault();show(targets[link.hash]);});
  nav.addEventListener('keydown',event=>{const i=links.indexOf(document.activeElement);if(i<0)return;let next=i;if(event.key==='ArrowRight')next=(i+1)%links.length;else if(event.key==='ArrowLeft')next=(i-1+links.length)%links.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=links.length-1;else return;event.preventDefault();event.stopPropagation();links[next].focus();show(targets[links[next].hash]);});
  show(targets[location.hash]||'bench',false);
  return {show,getView:()=>active};
}
