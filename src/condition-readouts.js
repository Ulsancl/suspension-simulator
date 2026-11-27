import { roadHeight } from './physics.js';
import './condition-readouts.css';

const GRAVITY = 9.80665;
const ROAD_SPAN_M = 6;
const ROAD_HEIGHT_SCALE_M = .25;
const PREVIEW_TIME_S = .1;
const ROAD_WIDTH = 600;
const ROAD_ZERO = 34;
const ROAD_AMPLITUDE = 28;

export const staticContactLoad = config => (config.sprungMass + config.unsprungMass) * GRAVITY;

export function signedValue(value, digits) {
  const magnitude = Math.abs(value).toFixed(digits);
  return Number(magnitude) ? `${value < 0 ? '−' : '+'}${magnitude}` : magnitude;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

export function mountConditionGauges() {
  const travel = document.getElementById('travel-value').closest('.metric-card');
  const contact = document.getElementById('contact-value').closest('.metric-card');
  travel.classList.add('condition-metric');
  contact.classList.add('condition-metric');
  // The force shown here is the upward reaction on the wheel.
  contact.querySelector('.metric-label path').setAttribute('d', 'M3 16h14M10 13V3m-3 3 3-3 3 3');

  function mountScale(card) {
    const scale = document.createElement('div');
    scale.className = 'condition-scale';
    scale.innerHTML = `<div class="condition-track" aria-hidden="true"><i class="condition-fill"></i><i class="condition-reference"></i><i class="condition-pointer"></i></div><div class="condition-scale-labels"><span class="condition-scale-status"></span><span></span></div>`;
    card.querySelector('small').remove();
    card.querySelector('.metric-rule').replaceWith(scale);
    return {
      status: scale.lastElementChild.firstElementChild,
      track: scale.firstElementChild,
      caption: scale.lastElementChild.lastElementChild,
    };
  }
  const strokeScale = mountScale(travel);
  const loadScale = mountScale(contact);

  function position(track, value, reference, anchor = reference) {
    track.style.setProperty('--position', `${value}%`);
    track.style.setProperty('--reference', `${reference}%`);
    track.style.setProperty('--start', `${Math.min(value, anchor)}%`);
    track.style.setProperty('--length', `${Math.abs(value - anchor)}%`);
  }

  return function update(state, config) {
    const { travelBump: bump, travelRebound: rebound } = config;
    const strokePercent = value => 100 * (value + rebound) / (bump + rebound);
    const zero = strokePercent(0);
    position(strokeScale.track, strokePercent(Math.max(-rebound, Math.min(bump, state.travel))), zero);
    const stroke = state.bottomed ? 'bump-stop' : state.toppedOut ? 'rebound-stop' : Math.abs(state.travel) < .00005 ? 'neutral' : state.travel > 0 ? 'bump' : 'rebound';
    travel.dataset.stroke = stroke;
    setText(strokeScale.status, {
      neutral: '정적 기준 위치', bump: '압축 위치', rebound: '신장 위치',
      'bump-stop': '압축 한계 초과', 'rebound-stop': '신장 한계 초과',
    }[stroke]);
    setText(strokeScale.caption, `신장 ${signedValue(-rebound * 1000, 1)} / 압축 ${signedValue(bump * 1000, 1)} mm`);

    const staticLoad = staticContactLoad(config);
    const loadFraction = state.contactForce / staticLoad;
    position(loadScale.track, Math.min(100, 50 * loadFraction), 50, 0);
    contact.dataset.load = !state.contact ? 'lost' : loadFraction > 2 ? 'over' : 'contact';
    setText(loadScale.status, state.contact ? `접지 중 · 정적의 ${Math.round(loadFraction * 100)}%` : '접지 이탈');
    setText(loadScale.caption, `정적 ${(staticLoad / 1000).toFixed(2)} kN · 상한 2×`);
  };
}

export function mountRoadProfile(panel) {
  const profile = document.createElement('section');
  profile.className = 'condition-road';
  profile.setAttribute('aria-labelledby', 'condition-road-title');
  profile.innerHTML = `<div class="condition-road-heading"><h3 id="condition-road-title">노면 단면</h3><p data-road-position></p></div>
    <svg viewBox="0 0 ${ROAD_WIDTH} 72" preserveAspectRatio="none" aria-hidden="true">
      <path class="condition-road-baseline" d="M0 ${ROAD_ZERO}H${ROAD_WIDTH}"/>
      <path class="condition-road-profile" fill="none"/>
      <line class="condition-road-current" y1="0" y2="${ROAD_ZERO}"/>
      <line class="condition-road-distance" y1="65" y2="65"/>
      <line class="condition-road-end" y1="62" y2="68"/>
    </svg>
    <div class="condition-road-caption"><span>거리 6 m · 높이 ±250 mm</span><span data-road-preview></span></div>`;
  panel.prepend(profile);
  const surface = profile.querySelector('.condition-road-profile');
  const current = profile.querySelector('.condition-road-current');
  const distance = profile.querySelector('.condition-road-distance');
  const end = profile.querySelector('.condition-road-end');
  const position = profile.querySelector('[data-road-position]');
  const preview = profile.querySelector('[data-road-preview]');
  const elevation = height => (ROAD_ZERO - ROAD_AMPLITUDE * height / ROAD_HEIGHT_SCALE_M).toFixed(1);
  let lastConfig, lastOrigin;

  return function update(config, state) {
    const origin = Math.max(0, Math.floor((state.distance - 1) * 10) / 10);
    if (lastConfig !== config || lastOrigin !== origin) {
      const samples = 180;
      let path = '';
      for (let i = 0; i <= samples; i++) {
        const fraction = i / samples;
        path += `${i ? 'L' : 'M'}${(fraction * ROAD_WIDTH).toFixed(1)},${elevation(roadHeight(origin + fraction * ROAD_SPAN_M, config))}`;
      }
      surface.setAttribute('d', path);
      lastConfig = config;
      lastOrigin = origin;
    }
    const x = (state.distance - origin) * ROAD_WIDTH / ROAD_SPAN_M;
    const previewM = config.speed / 3.6 * PREVIEW_TIME_S;
    const xEnd = x + previewM * ROAD_WIDTH / ROAD_SPAN_M;
    current.setAttribute('x1', x.toFixed(1));
    current.setAttribute('x2', x.toFixed(1));
    current.setAttribute('y2', elevation(state.rawRoadY));
    distance.setAttribute('x1', x.toFixed(1));
    distance.setAttribute('x2', xEnd.toFixed(1));
    end.setAttribute('x1', xEnd.toFixed(1));
    end.setAttribute('x2', xEnd.toFixed(1));
    setText(position, `현재 ${state.distance.toFixed(2)} m · 노면 ${signedValue(state.rawRoadY * 1000, 1)} mm`);
    setText(preview, `0.1초 이동 거리 ${previewM.toFixed(2)} m`);
  };
}
