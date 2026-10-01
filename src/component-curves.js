const cache = new WeakMap();
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, fallback) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0,160) || fallback : fallback;
function table(input, type) {
  if(!Array.isArray(input)||input.length<2||input.length>1000)throw new Error(`${type} 곡선은 2–1000개 점이 필요합니다.`);
  const points=input.map((point,i)=>{
    if(!Array.isArray(point)||point.length!==2||!point.every(numeric))throw new Error(`${type} 곡선 ${i+1}번째 점은 유한한 숫자 두 개여야 합니다.`);
    const [x,y]=point;
    if(Math.abs(x)>(type==='spring'?1:10)||Math.abs(y)>2e6||type==='spring'&&(x<0||y<0))throw new Error(`${type} 곡선의 좌표 또는 힘 범위를 확인하세요.`);
    if(i&&x<=input[i-1][0])throw new Error(`${type} 곡선의 입력 좌표는 중복 없이 증가해야 합니다.`);
    if(type==='spring'&&i&&y<=input[i-1][1])throw new Error('스프링 힘은 압축량에 따라 엄격하게 증가해야 합니다.');
    if(i && Math.abs((y-input[i-1][1])/(x-input[i-1][0])) > (type==='spring'?1e7:200000))throw new Error(`${type} 곡선의 국부 기울기가 해석 범위를 넘습니다. 데이터의 단위·중복점을 확인하세요.`);
    if(type==='damper'&&x*y<0)throw new Error('댐퍼 곡선은 에너지를 소산하는 부호여야 합니다. 압축 속도·힘은 양수입니다.');
    return Object.freeze([x,y]);
  });
  if(type==='damper'){
    if(!points.some(([x,y])=>x===0&&y===0)||points[0][0]>=0||points.at(-1)[0]<=0)throw new Error('댐퍼 곡선은 음·양 속도와 [0,0] 점이 필요합니다.');
  }
  return Object.freeze(points);
}
export function validateComponentProfile(input) {
  if(input===null||input===undefined)return null;
  if(typeof input!=='object'||Array.isArray(input))throw new Error('부품 특성은 JSON 객체여야 합니다.');
  if(cache.has(input))return cache.get(input);
  if(input.format!=='suspension-components/v1'||input.units!=='SI')throw new Error('부품 곡선 형식과 SI 단위 선언을 확인하세요.');
  if(!input.spring&&!input.damper)throw new Error('스프링 또는 댐퍼 곡선을 하나 이상 입력하세요.');
  const profile=Object.freeze({format:'suspension-components/v1',units:'SI',name:text(input.name,'부품 특성 곡선'),source:text(input.source,'출처 미기재'),spring:input.spring?table(input.spring,'spring'):null,damper:input.damper?table(input.damper,'damper'):null});
  cache.set(input,profile);cache.set(profile,profile);return profile;
}
export function interpolateCurve(points,x) {
  let lo=0,hi=points.length-1;
  while(lo+1<hi){const mid=(lo+hi)>>1;if(points[mid][0]<=x)lo=mid;else hi=mid;}
  if(x<points[0][0]){lo=0;hi=1;}else if(x>points.at(-1)[0]){lo=points.length-2;hi=points.length-1;}
  const a=points[lo],b=points[hi],slope=(b[1]-a[1])/(b[0]-a[0]);
  return {value:a[1]+slope*(x-a[0]),slope,outOfRange:x<points[0][0]||x>points.at(-1)[0]};
}
export function createCurveModel(input,{sprungMass,motionRatio}) {
  const profile=validateComponentProfile(input);if(!profile)return null;
  const mr=motionRatio,load=sprungMass*9.80665/mr;
  let staticCompression=null,tangentRate=null;
  if(profile.spring){
    const points=profile.spring;
    if(load<points[0][1]||load>points.at(-1)[1])throw new Error('스프링 곡선에 정적 축하중이 포함되지 않습니다. 힘 범위를 넓히거나 질량·모션 비율을 확인하세요.');
    let i=0;while(i<points.length-2&&points[i+1][1]<load)i++;
    const a=points[i],b=points[i+1];staticCompression=a[0]+(load-a[1])*(b[0]-a[0])/(b[1]-a[1]);tangentRate=interpolateCurve(points,staticCompression+1e-10).slope;
  }
  const maximumSlope = points => points ? Math.max(...points.slice(1).map((point,i)=>Math.abs((point[1]-points[i][1])/(point[0]-points[i][0])))) : 0;
  return {profile,staticCompression,tangentRate,springMaxSlope:maximumSlope(profile.spring),damperMaxSlope:maximumSlope(profile.damper),
    evaluateSpring(travel){const result=interpolateCurve(profile.spring,staticCompression+mr*travel);return {force:Math.max(0,result.value)*mr,outOfRange:result.outOfRange};},
    evaluateDamper(velocity){const speed=mr*velocity,result=interpolateCurve(profile.damper,speed);const force=speed>=0?Math.max(0,result.value):Math.min(0,result.value);return {force:force*mr,outOfRange:result.outOfRange};},
  };
}
export const COMPONENT_PROFILE_TEMPLATE = Object.freeze({
  format:'suspension-components/v1',units:'SI',name:'입력 형식 예제 · 실측 데이터 아님',source:'선형32kN/m·압축1800/리바운드2800N·s/m 수식으로 생성한 예제',
  spring:[[0,0],[.1,3200],[.2,6400],[.3,9600],[.4,12800]],
  damper:[[-3,-8400],[-1,-2800],[0,0],[1,1800],[3,5400]],
});
