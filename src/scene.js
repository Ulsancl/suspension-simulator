import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { getGeometry, roadHeight } from './physics.js';
import { part, block, cylinder, ring, align, vector, destroy, consolidate, fastener, bearing, adjustableRod, armLimb, wishboneWeb, springAssembly, annotation, sidewallTexture } from './rig-parts.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 9.80665;
const MATERIALS = {
  metal: new THREE.MeshStandardMaterial({ color: 0x899ba7, metalness: .84, roughness: .34 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc6d4df, metalness: .96, roughness: .19 }),
  darkMetal: new THREE.MeshStandardMaterial({ color: 0x29313b, metalness: .84, roughness: .33 }),
  red: new THREE.MeshPhysicalMaterial({ color: 0x9f211b, metalness: .58, roughness: .30, clearcoat: .45, clearcoatRoughness: .23 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x15191e, metalness: 0, roughness: .86 }),
  tread: new THREE.MeshStandardMaterial({ color: 0x20252b, metalness: 0, roughness: .83 }),
  teal: new THREE.MeshStandardMaterial({ color: 0x37978c, metalness: .76, roughness: .33 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xae8949, metalness: .80, roughness: .3 }),
  spring: new THREE.MeshPhysicalMaterial({ color: 0x465463, metalness: .85, roughness: .22, clearcoat: .25 }),
  painted: new THREE.MeshStandardMaterial({ color: 0x17212d, metalness: .50, roughness: .42 }),
  caution: new THREE.MeshStandardMaterial({ color: 0xac8852, metalness: .25, roughness: .62 }),
};
MATERIALS.chrome.userData.darkMaterial = MATERIALS.darkMetal;

function noiseTexture(type) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d'); const data = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const hashed = ((x * 7919 + y * 13441) ^ (x * y * 17)) & 255;
    const value = type === 'brushed' ? 121 + hashed % 17 + Math.sin(y * 2.4) * 13 : 108 + hashed % 43;
    const index = (y * 256 + x) * 4; data.data[index] = value; data.data[index + 1] = value; data.data[index + 2] = value; data.data[index + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(type === 'brushed' ? 2 : 5, type === 'brushed' ? 12 : 5); return texture;
}

function studioEnvironment(renderer) {
  const room = new THREE.Scene(); room.background = new THREE.Color(0x0a0e13);
  const geometries = new Set(), materials = new Set();
  const geometry = new THREE.BoxGeometry(1, 1, 1); geometries.add(geometry);
  const shellMaterial = new THREE.MeshBasicMaterial({ color: 0x53606b, side: THREE.BackSide }); materials.add(shellMaterial);
  const shell = new THREE.Mesh(geometry, shellMaterial); shell.scale.set(12, 8, 12); shell.position.y = 2; room.add(shell);
  const softbox = (position, size, color, intensity) => {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: false }); materials.add(material);
    const panel = new THREE.Mesh(geometry, material); panel.position.set(...position); panel.scale.set(...size); room.add(panel);
  };
  softbox([-4, 2.5, 2], [.1, 3.8, 2.4], 0xffeddc, 4.0);
  softbox([4.8, 2.0, -.8], [.1, 2.5, 1.0], 0xb7d4ef, 3.5);
  softbox([.2, 5.7, -.5], [4.0, .1, 2.6], 0xffffff, 2.8);
  softbox([-.4, 1.8, 4.8], [2.3, 2.8, .1], 0xd1dfeb, 1.3);
  softbox([1, 3.2, -4.8], [3.3, .35, .1], 0xaed0ed, 3.8);
  softbox([-3.5, 2.8, -4.2], [2.8, 3.6, .1], 0xe5eef5, 3.4);
  const pmrem = new THREE.PMREMGenerator(renderer), environment = pmrem.fromScene(room, .045, .1, 20);
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); pmrem.dispose(); return environment;
}

function contactTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 122);
  gradient.addColorStop(0, 'rgba(0,0,0,.64)'); gradient.addColorStop(.38, 'rgba(0,0,0,.24)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256); return new THREE.CanvasTexture(canvas);
}

class ModelSSAOPass extends SSAOPass {
  _overrideVisibility() {
    super._overrideVisibility();
    // Alpha decals and the contact-gradient plane are presentation surfaces;
    // their transparent regions must not become solid occluders in the depth pass.
    this.scene.traverse(object => {
      if(object.isMesh && object.visible && !Array.isArray(object.material) && object.material?.transparent) {
        object.visible=false; this._visibilityCache.push(object);
      }
    });
  }
}

function rail(parent, length, position, mats, axis = 'y', width = .075) {
  const extrusion = new THREE.Group(); extrusion.position.set(...position); parent.add(extrusion);
  block(extrusion, [width, length, width], [0, 0, 0], mats.metal, .004);
  for (const x of [-1, 1]) {
    block(extrusion, [.008, length * .99, .006], [x * width * .27, 0, width / 2 + .0004], mats.darkMetal, .001);
    block(extrusion, [.006, length * .99, .008], [width / 2 + .0004, 0, x * width * .27], mats.darkMetal, .001);
  }
  if (axis === 'x') extrusion.rotation.z = Math.PI / 2;
  if (axis === 'z') extrusion.rotation.x = Math.PI / 2;
  return extrusion;
}

function brakeRotor(parent, radius, mats) {
  const outer = radius * .49, inner = radius * .17, shape = new THREE.Shape(); shape.absarc(0, 0, outer, 0, TAU, false);
  const center = new THREE.Path(); center.absarc(0, 0, inner, 0, TAU, true); shape.holes.push(center);
  for (let row = 0; row < 2; row++) for (let i = 0; i < 26; i++) {
    const angle = (i + row * .5) * TAU / 26, r = outer * (.72 + row * .14), hole = new THREE.Path();
    hole.absarc(Math.cos(angle) * r, Math.sin(angle) * r, .0042, 0, TAU, true); shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: .008, bevelEnabled: true, bevelSegments: 1, bevelSize: .001, bevelThickness: .001, curveSegments: 8, steps: 1 });
  for (const z of [-.082, -.056]) part(parent, geo, mats.metal, [0, 0, z]);
  for (let i = 0; i < 30; i++) {
    const angle = i * TAU / 30, vane = block(parent, [.008, outer * .48, .023], [Math.sin(angle) * outer * .64, Math.cos(angle) * outer * .64, -.065], mats.darkMetal, .002); vane.rotation.z = -angle + .18;
  }
  const hat = cylinder(parent, inner * 1.10, .033, mats.darkMetal, [0, 0, -.065]); hat.rotation.x = Math.PI / 2;
  ring(parent, outer * .93, .0008, mats.chrome, [0, 0, -.046]);
}

export class SuspensionScene {
  constructor(container, config) {
    this.container = container; this.config = config; this.quality = 'high'; this.studioMode = 'studio'; this.componentFocus = 'all'; this.options = { links: true, forces: false, labels: true };
    this.frameTimes = []; this.renderCount = 0; this.lastRenderAt = -Infinity; this.cpuRenderMs = 0; this.exportCount = 0; this.labelViewVector = new THREE.Vector3();
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x0b131d); this.scene.fog = new THREE.FogExp2(0x0b131d, .065);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false; this.shadowsDirty = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.04;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.setAttribute('aria-label', '정밀 서스펜션 시험 장치 3D 뷰. 드래그로 회전, 휠로 확대합니다.');
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(34, 1, .025, 25);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = .09; this.controls.minDistance = .30; this.controls.maxDistance = 10;
    this.controls.maxPolarAngle = Math.PI * .49;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.target.set(0, .49, -.31);
    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.environments = { technical: pmrem.fromScene(room, .03), studio: studioEnvironment(this.renderer) }; this.environment = this.environments.studio;
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .85;
    room.dispose(); pmrem.dispose();
    this.hemiLight = new THREE.HemisphereLight(0xb7d5ee, 0x25202b, .52); this.scene.add(this.hemiLight);
    this.keyLight = new THREE.DirectionalLight(0xffe9d5, 2.35); this.keyLight.position.set(-2.0, 4.5, 3.2); this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048); Object.assign(this.keyLight.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -1.8, near: .2, far: 11 });
    this.keyLight.target.position.set(0, .35, -.30); this.scene.add(this.keyLight.target);
    this.keyLight.shadow.bias = -.00008; this.keyLight.shadow.normalBias = .002; this.keyLight.shadow.radius = 3; this.scene.add(this.keyLight);
    this.rimLight = new THREE.DirectionalLight(0x9ebfde, 1.55); this.rimLight.position.set(2.4, 2.9, -2.8); this.scene.add(this.rimLight);
    this.fillLight = new THREE.DirectionalLight(0xd5e0ed, .40); this.fillLight.position.set(-3, 1, -1); this.scene.add(this.fillLight);
    this.frontFill = new THREE.DirectionalLight(0xdbe4ef, .45); this.frontFill.position.set(0, .6, 4); this.scene.add(this.frontFill);
    this.floorMaterial = new THREE.MeshStandardMaterial({ color: 0x101720, roughness: .64, metalness: .18 });
    this.floor = part(this.scene, new THREE.PlaneGeometry(70, 70), this.floorMaterial, [0, -.39, 0]); this.floor.rotation.x = -Math.PI / 2; this.floor.castShadow = false;
    this.grid = new THREE.GridHelper(22, 88, 0x527289, 0x365069); this.grid.position.y = -.388; this.grid.material.opacity = .25; this.grid.material.transparent = true; this.grid.visible = false; this.scene.add(this.grid);
    this.surfaceTextures = [noiseTexture('brushed'), noiseTexture('rubber')];
    this.mats = Object.fromEntries(Object.entries(MATERIALS).map(([key, mat]) => [key, mat.clone()]));
    this.mats.metal.bumpMap = this.surfaceTextures[0]; this.mats.metal.bumpScale = .00032;
    this.mats.rubber.bumpMap = this.surfaceTextures[1]; this.mats.rubber.bumpScale = .00075;
    this.mats.chrome.userData.darkMaterial = this.mats.darkMetal;
    this.buildTreadmill();
    const contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, depthWrite: false, opacity: .38 }); contactMaterial.userData.owned = true;
    this.contactShadow = part(this.scene, new THREE.PlaneGeometry(.62, .32), contactMaterial); this.contactShadow.rotation.x = -Math.PI / 2; this.contactShadow.castShadow = false; this.contactShadow.receiveShadow = false; this.contactShadow.renderOrder = 1;
    this.rig = new THREE.Group(); this.rig.name = 'wheel-and-fixture'; this.scene.add(this.rig);
    this.linkGroup = new THREE.Group(); this.linkGroup.name = 'suspension-assembly'; this.scene.add(this.linkGroup);
    this.labelGroup = new THREE.Group(); this.scene.add(this.labelGroup);
    this.forceGroup = new THREE.Group(); this.scene.add(this.forceGroup);
    this.contactArrow = new THREE.ArrowHelper(UP, vector([0, .04, .2]), .5, 0x58cfbd, .065, .03); this.forceGroup.add(this.contactArrow);
    this.springArrow = new THREE.ArrowHelper(UP, vector([0, .34, -.25]), .5, 0xe3ac61, .065, .03); this.forceGroup.add(this.springArrow);
    this.forceGroup.visible = false; this.buildRig(config); this.setCamera('iso');
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container); this.resize();
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); container.dispatchEvent(new CustomEvent('scene-error', { detail: '3D 그래픽 연결이 끊겼습니다. 페이지를 새로 고침해 주세요.' }));
    });
  }

  buildTreadmill() {
    const mats = this.mats, base = new THREE.Group(); this.testBench = base; base.name = 'moving-road-dynamometer'; this.scene.add(base);
    block(base, [7.45, .15, 1.34], [0, -.235, 0], mats.painted, .025);
    block(base, [7.30, .055, 1.23], [0, -.137, 0], mats.darkMetal, .010);
    for (const z of [-.684, .684]) {
      rail(base, 7.50, [0, -.085, z], mats, 'x', .08);
      block(base, [7.50, .039, .09], [0, -.036, z], mats.metal, .007);
      block(base, [7.40, .006, .042], [0, -.011, z], mats.darkMetal, .002);
      for (let i = 0; i < 37; i++) {
        const tick = block(base, [.080, .006, .040], [-3.58 + i * .197, -.006, z], mats.caution, .001); tick.rotation.y = -.38;
      }
      for (let i = 0; i < 20; i++) fastener(base, [-3.54 + i * .374, -.027, z + (z > 0 ? .053 : -.053)], mats.chrome, .009, 'z');
      for (const x of [-2.87, 2.87]) {
        rail(base, .22, [x, -.27, z], mats, 'y', .11);
        const foot = cylinder(base, .085, .025, mats.rubber, [x, -.374, z]); foot.name = 'vibration-isolating-foot';
      }
    }
    this.rollers = [];
    for (const x of [-3.60, 3.60]) {
      const roller = cylinder(base, .116, 1.22, mats.darkMetal, [x, -.120, 0], 64); roller.rotation.x = Math.PI / 2; this.rollers.push(roller);
      for (const z of [-.69, .69]) {
        const cap = cylinder(base, .117, .078, mats.metal, [x, -.120, z], 48); cap.rotation.x = Math.PI / 2;
        const end = cylinder(base, .036, .085, mats.chrome, [x, -.120, z * 1.073], 32); end.rotation.x = Math.PI / 2;
        block(base, [.29, .27, .065], [x, -.11, z], mats.painted, .018);
        fastener(base, [x, -.120, z * 1.082], mats.chrome, .022, 'z');
      }
    }
    block(base, [.45, .24, .30], [3.04, -.19, -.84], mats.painted, .040);
    const motor = cylinder(base, .102, .32, mats.metal, [3.04, -.17, -.99], 48); motor.rotation.x = Math.PI / 2;
    for (let i = 0; i < 9; i++) {
      const fin = cylinder(base, .115, .011, mats.darkMetal, [3.04, -.17, -.85 - i * .032], 48); fin.rotation.x = Math.PI / 2;
    }
    consolidate(base, this.rollers);
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#282c30'; ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 8) { ctx.fillStyle = y % 16 === 0 ? '#32373b' : '#202529'; ctx.fillRect(0, y, 256, 3); }
    ctx.fillStyle = '#12181d'; ctx.fillRect(0, 0, 5, 256); ctx.fillRect(128, 0, 4, 256);
    ctx.fillStyle = '#43494d'; for (let x = 8; x < 256; x += 10) for (let y = 2; y < 256; y += 16) ctx.fillRect(x, y, 1, 4);
    this.beltTexture = new THREE.CanvasTexture(canvas); this.beltTexture.colorSpace = THREE.SRGBColorSpace; this.beltTexture.wrapS = this.beltTexture.wrapT = THREE.RepeatWrapping; this.beltTexture.repeat.set(26, 4);
    const roadMat = new THREE.MeshStandardMaterial({ map: this.beltTexture, bumpMap: this.beltTexture, bumpScale: .0013, roughness: .90, metalness: .08, side: THREE.DoubleSide });
    const sections = 720, geometry = new THREE.BufferGeometry(), positions = [], uvs = [], indices = [];
    for (let i = 0; i <= sections; i++) { const x = -3.6 + 7.2 * i / sections; for (const z of [-.615, .615]) { positions.push(x, 0, z); uvs.push(i / sections, (z + .615) / 1.23); } }
    for (let i = 0; i < sections; i++) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
    this.roadMesh = part(this.scene, geometry, roadMat); this.roadMesh.castShadow = false; this.roadMesh.name = 'raw-road-surface';
    const edgePositions = new Float32Array((sections + 1) * 2 * 3), edgeIndices = [];
    for (let i = 0; i <= sections; i++) { edgePositions[i * 6] = -3.6 + 7.2 * i / sections; edgePositions[i * 6 + 2] = .616; edgePositions[i * 6 + 3] = edgePositions[i * 6]; edgePositions[i * 6 + 4] = -.145; edgePositions[i * 6 + 5] = .616; }
    for (let i = 0; i < sections; i++) { const n = i * 2; edgeIndices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); }
    const edgeGeo = new THREE.BufferGeometry(); edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3)); edgeGeo.setIndex(edgeIndices); edgeGeo.computeVertexNormals();
    this.beltEdge = part(this.scene, edgeGeo, mats.rubber); this.beltEdge.castShadow = false;
    this.beltMark = annotation('MOVING ROAD  /  DYNAMOMETER', '#aab9c8'); this.beltMark.position.set(.20, .12, .40); this.beltMark.scale.multiplyScalar(.68); this.scene.add(this.beltMark);
  }

  buildHolder(geom, config) {
    const mats = this.mats;
    this.holderHeight=config.tireRadius+.88;
    this.holder = new THREE.Group(); this.holder.name = 'bolted-test-fixture'; this.rig.add(this.holder);
    block(this.holder, [.89, .085, .48], [0, -.095, -.96], mats.metal, .016);
    for (const x of [-.30, .30]) {
      rail(this.holder, this.holderHeight, [x, this.holderHeight/2-.05, -1.10], mats, 'y', .09);
      rail(this.holder, .53, [x, -.030, -1.02], mats, 'z', .08);
      for (const z of [-.84, -1.18]) fastener(this.holder, [x, -.045, z], mats.chrome, .013, 'y');
      const brace = cylinder(this.holder, .022, 1, mats.metal); align(brace, [x, -.050, -1.20], [x, .31, -1.08], true);
      block(this.holder, [.085, .19, .03], [x, .12, -1.044], mats.darkMetal, .005);
      for (const y of [.08, .17]) fastener(this.holder, [x, y, -1.022], mats.chrome, .011, 'z');
    }
    for (const y of [.115, .61, this.holderHeight-.08]) rail(this.holder, .70, [0, y, -1.10], mats, 'x', .075);
    block(this.holder, [.53, .34, .045], [0, .55, -1.160], mats.painted, .012);
    // Cantilever cross members terminate at the actual chassis pivots.
    this.mounts = [];
    for (const point of geom.points.filter(p => p.kind === 'chassis')) {
      const [x, y, z] = point.position;
      rail(this.holder, Math.max(.1, z + 1.10), [x, y, (-1.10 + z) / 2], mats, 'z', .047);
      block(this.holder, [.09, .083, .025], [x, y, -1.050], mats.darkMetal, .004);
      for (const offset of [-.029, .029]) fastener(this.holder, [x + offset, y, -1.030], mats.chrome, .008, 'z');
      const mount = new THREE.Group(); this.holder.add(mount); mount.position.set(x, y, z);
      for (const dx of [-.037, .037]) block(mount, [.012, .086, .075], [dx, .016, 0], mats.metal, .003);
      bearing(mount, [0, 0, 0], mats, point.id === 'strut-top' ? 1.00 : .78);
      this.mounts.push({ point, mesh: mount });
    }
    if (config.structure !== 'macpherson') {
      const [x, y, z] = geom.springTop;
      rail(this.holder, .62, [0, y, -1.10], mats, 'x', .085);
      rail(this.holder, z + 1.10, [x, y, (z - 1.10) / 2], mats, 'z', .070);
      const mount = new THREE.Group(); this.holder.add(mount); mount.position.set(x, y, z);
      for (const dx of [-.042, .042]) block(mount, [.014, .088, .085], [dx, .020, 0], mats.metal, .004);
      bearing(mount, [0, 0, 0], mats, .88);
    }
    this.holderLabel = annotation(config.holderMode === 'fixed' ? '01   FIXED TEST FIXTURE' : '01   SPRUNG MASS FIXTURE');
    this.holderLabel.position.set(-.06, this.holderHeight, -1.08); this.labelGroup.add(this.holderLabel);
    consolidate(this.holder);
  }

  buildWheel(config) {
    const mats = this.mats, r = config.tireRadius;
    this.wheel = new THREE.Group(); this.wheel.name = 'wheel-and-brake'; this.rig.add(this.wheel);
    this.spin = new THREE.Group(); this.spin.name = 'rotating-alloy-wheel'; this.wheel.add(this.spin);
    const profile = [[.61,-.101],[.62,-.113],[.68,-.122],[.79,-.125],[.88,-.119],[.94,-.107],[.982,-.086],[.997,-.061],[1,-.031],[1,.031],[.997,.061],[.982,.086],[.94,.107],[.88,.119],[.79,.125],[.68,.122],[.62,.113],[.61,.101]].map(([rad,z]) => new THREE.Vector2(rad * r,z));
    const tire = part(this.spin, new THREE.LatheGeometry(profile, 128), mats.rubber); tire.rotation.x = Math.PI / 2; tire.name = 'curved-shoulder-radial-tire';
    const treadGeo = new THREE.BoxGeometry(.024, .0038, .043), tread = new THREE.InstancedMesh(treadGeo, mats.tread, 384), temp = new THREE.Object3D();
    let index = 0;
    for (let i = 0; i < 96; i++) for (let row = 0; row < 4; row++) {
      const z = (row - 1.5) * .046, angle = i * TAU / 96 + (row % 2) * .009, radius = r * (Math.abs(z) > .05 ? .994 : 1.001);
      temp.position.set(Math.sin(angle) * radius, Math.cos(angle) * radius, z); temp.rotation.set(0, (row < 2 ? -1 : 1) * .24, -angle); temp.updateMatrix(); tread.setMatrixAt(index++, temp.matrix);
    }
    tread.castShadow = true; tread.receiveShadow = true; tread.name = '384-directional-tread-blocks'; this.spin.add(tread);
    for (const z of [-.126, .126]) {
      const map = sidewallTexture(r), material = new THREE.MeshStandardMaterial({ map, transparent: true, roughness: .85, polygonOffset: true, polygonOffsetFactor: -1 }); material.userData.owned = true;
      const sidewall = part(this.spin, new THREE.RingGeometry(r * .68, r * .98, 128), material, [0,0,z]); sidewall.name = 'embossed-sidewall-lettering'; sidewall.castShadow = false; if (z < 0) sidewall.rotation.y = Math.PI;
      for (const ratio of [.646,.685,.945]) ring(this.spin, r * ratio, .0018, mats.tread, [0,0,z * .948]);
    }
    const barrelProfile = [[r*.585,-.09],[r*.62,-.09],[r*.626,-.076],[r*.609,-.058],[r*.604,.065],[r*.626,.091],[r*.622,.107],[r*.590,.107]].map(([rad,z])=>new THREE.Vector2(rad,z));
    const barrel = part(this.spin, new THREE.LatheGeometry(barrelProfile, 96), mats.darkMetal); barrel.rotation.x = Math.PI / 2; barrel.name = 'alloy-rim-barrel';
    for (const z of [-.084,.104]) { ring(this.spin,r*.617,.0065,mats.chrome,[0,0,z],96); ring(this.spin,r*.587,.003,mats.metal,[0,0,z],96); }
    for(let i=0;i<5;i++) for(const split of [-1,1]) {
      const angle=i*TAU/5 + split*.065, inner=[Math.sin(angle)*r*.19,Math.cos(angle)*r*.19,.124], outer=[Math.sin(angle+split*.075)*r*.58,Math.cos(angle+split*.075)*r*.58,.084];
      const spoke=block(this.spin,[.022,1,.022],[0,0,0],mats.metal,.005); align(spoke,inner,outer,true); spoke.name='concave-split-spoke';
      const inset=block(this.spin,[.007,1,.003],[0,0,0],mats.darkMetal,.001); align(inset,[inner[0],inner[1],inner[2]+.012],[outer[0],outer[1],outer[2]+.012],true);
    }
    const hub=cylinder(this.spin,r*.176,.032,mats.metal,[0,0,.109]); hub.rotation.x=Math.PI/2;
    const cap=cylinder(this.spin,r*.079,.038,mats.darkMetal,[0,0,.133]); cap.rotation.x=Math.PI/2;
    ring(this.spin,r*.079,.0015,mats.chrome,[0,0,.153]);
    for(let i=0;i<5;i++) { const a=i*TAU/5; fastener(this.spin,[Math.sin(a)*r*.121,Math.cos(a)*r*.121,.127],mats.chrome,.0095,'z'); }
    const valve=cylinder(this.spin,.004,.021,mats.rubber,[r*.52,0,.107],16); valve.rotation.z=Math.PI/2;
    brakeRotor(this.spin,r,mats);
    consolidate(this.spin);
    const caliper=new THREE.Group(); this.wheel.add(caliper); caliper.position.set(-r*.39,r*.11,-.071); caliper.rotation.z=.27;
    block(caliper,[.061,.151,.085],[0,0,0],mats.red,.019);
    for(const y of [-.045,.045]) { block(caliper,[.074,.029,.095],[0,y,0],mats.red,.009); fastener(caliper,[.039,y,.044],mats.chrome,.006,'x'); }
    block(caliper,[.012,.091,.002],[.006,0,.049],mats.metal,.003); caliper.name='fixed-red-brake-caliper';
    consolidate(caliper);
    this.hubLabel=annotation('04   TIRE / VENTED BRAKE', '#b8c4d4'); this.hubLabel.position.set(.45,.73,.14); this.hubLabel.scale.multiplyScalar(.88); this.labelGroup.add(this.hubLabel);
  }

  buildRig(config) {
    const signature = [config.structure, config.springType, config.tireRadius, config.holderMode].join('/');
    this.config=config; this.lastStateTime=-1; this.dirty=true;
    if (this.rigSignature === signature) return;
    this.endInspection();
    this.lastGeometry=null; this.rigSignature = signature; this.needsFit = true; this.shadowsDirty=true;
    destroy(this.rig); destroy(this.linkGroup); destroy(this.labelGroup);
    const geom=getGeometry(config,0); this.buildHolder(geom,config); this.buildWheel(config);
    this.components=['curved-radial-tire','directional-tread','embossed-sidewalls','concave-alloy-rim','drilled-vented-brake','fixed-caliper','bolted-t-slot-fixture','aligned-pivot-mounts','engineered-holder'];
    const mats=this.mats; this.linkParts=[]; this.webs=[]; this.crossbars=[];
    // Hub/knuckle segments describe the rigid upright, not additional arms.
    const structural=geom.links.filter(link => link.kind !== 'strut' && !(link.a==='lower-ball'&&link.b==='hub') && !(link.a==='hub'&&link.b==='upper-ball'));
    for(const link of structural) {
      const useArm=config.structure !== 'multilink' && link.kind !== 'tie';
      const assembly=useArm ? armLimb(this.linkGroup,mats,`${link.kind}-forged-wishbone-limb`) : adjustableRod(this.linkGroup,mats,link.kind==='tie'?mats.chrome:link.a.includes('upper')?mats.teal:mats.metal,link.kind==='tie'?.0105:.017,link.kind==='tie'?'steering-tie-rod':'adjustable-multilink-rod');
      this.linkParts.push({...link,assembly});
    }
    const pairs=[['lower-front','lower-rear','lower-ball']]; if(config.structure==='wishbone') pairs.push(['upper-front','upper-rear','upper-ball']);
    if(config.structure!=='multilink') for(const ids of pairs) {
      this.webs.push({ids,part:wishboneWeb(this.linkGroup,mats)});
      const bar=cylinder(this.linkGroup,.025,1,mats.red); bar.name='wishbone-pivot-cross-tube'; this.crossbars.push({ids:ids.slice(0,2),mesh:bar});
    }
    this.components.push(config.structure==='wishbone'?'two-triangular-forged-a-arms':config.structure==='multilink'?'five-independent-adjustable-rods':'lower-a-arm-and-telescopic-strut');
    this.joints=geom.points.filter(p=>p.kind!=='chassis'&&p.id!=='hub').map(p=>({id:p.id,mesh:bearing(this.linkGroup,[0,0,0],mats,p.id==='lower-ball'?.82:.61,'x')}));
    this.knuckle=new THREE.Group(); this.knuckle.name='cast-knuckle-and-hub-carrier'; this.linkGroup.add(this.knuckle);
    this.upright=block(this.knuckle,[.070,1,.055],[0,0,0],mats.metal,.012);
    this.knuckleSpine=block(this.knuckle,[.085,1,.024],[0,0,-.031],mats.metal,.007);
    this.carrier=new THREE.Group(); this.linkGroup.add(this.carrier);
    const flange=cylinder(this.carrier,.071,.043,mats.metal,[0,0,-.043],48); flange.rotation.x=Math.PI/2;
    const hubShell=cylinder(this.carrier,.049,.099,mats.darkMetal,[0,0,-.05],40); hubShell.rotation.x=Math.PI/2;
    this.axle=cylinder(this.linkGroup,.021,1,mats.chrome); this.axle.name='polished-hub-spindle';
    for(let i=0;i<4;i++) { const a=i*TAU/4; fastener(this.carrier,[Math.sin(a)*.054,Math.cos(a)*.054,-.078],mats.chrome,.008,'z'); }
    this.spring=springAssembly(this.linkGroup,mats,config.springType,config.structure==='macpherson');
    this.components.push(config.springType==='air'?'five-convolution-air-bellows':config.springType==='progressive'?'variable-pitch-helical-coil':'helical-coilover', 'damper-piston-collars-eyelets');
    this.linkLabel=annotation(config.structure==='wishbone'?'02   DOUBLE WISHBONE':config.structure==='multilink'?'02   FIVE LINK GEOMETRY':'02   MACPHERSON STRUT','#d5796e'); this.linkLabel.position.set(-.41,config.tireRadius+.12,-.39); this.linkLabel.scale.multiplyScalar(.88); this.labelGroup.add(this.linkLabel);
    this.springLabel=annotation(config.springType==='air'?'03   AIR BELLOWS + DAMPER':config.springType==='progressive'?'03   VARIABLE PITCH COIL':config.structure==='macpherson'?'03   INTEGRATED STRUT':'03   COILOVER + RESERVOIR','#c8b590'); this.springLabel.position.set(.42,config.tireRadius+.78,-.58); this.springLabel.scale.multiplyScalar(.83); this.labelGroup.add(this.springLabel);
    const lineMat=new THREE.LineBasicMaterial({color:0x8295a8,transparent:true,opacity:.35}); lineMat.userData.owned=true;
    this.labelLeaders=[];
    for(const [a,b] of [[[-.41,.43,-.39],[-.22,.31,-.54]],[[.42,1.09,-.58],[.07,.96,-.69]],[[.45,.69,.14],[.23,.55,.11]]]) {
      a[1]+=config.tireRadius-.34; b[1]+=config.tireRadius-.34;
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([vector(a),vector(b)]),lineMat); this.labelGroup.add(line); this.labelLeaders.push(line);
    }
    this.labelGroup.traverse(o => o.layers.set(1)); this.forceGroup.traverse(o => o.layers.set(1)); this.beltMark.layers.set(1);
    for(const sprite of [this.holderLabel,this.linkLabel,this.springLabel,this.hubLabel]) sprite.userData.displayScale=sprite.scale.toArray();
    this.beltMark.userData.displayScale ||= this.beltMark.scale.toArray();
    this.wheel.visible = this.componentFocus !== 'suspension';
    this.setOptions(this.options);
  }

  setCamera(view) {
    this.cameraView=['iso','side','front'].includes(view) ? view : 'iso';
    if(this.inspection) this.inspection.view=this.cameraView;
    this.fitComponent(); this.dirty=true;
  }

  setOptions(options) {
    this.options={...this.options,...options}; this.linkGroup.visible=this.options.links; this.forceGroup.visible=this.options.forces;
    this.labelGroup.visible=this.options.labels && this.componentFocus==='all'; this.beltMark.visible=this.labelGroup.visible; this.dirty=true;
    this.applyInspectionVisibility();
  }

  getCameraState() {
    return { position:this.camera.position.toArray(),target:this.controls.target.toArray(),zoom:this.camera.zoom,view:this.cameraView };
  }

  getInspection() { return this.inspection ? { id:this.inspection.id } : null; }

  beginInspection(id) {
    if (!['spring','damper'].includes(id) || !this.lastGeometry) return false;
    if (this.inspection?.id===id) return true;
    this.endInspection();
    const visibility=new Map();
    for (const node of [this.rig,this.testBench,this.roadMesh,this.beltEdge,this.floor,this.grid,this.contactShadow,this.labelGroup,this.forceGroup,...this.linkGroup.children]) visibility.set(node,node.visible);
    this.inspection={id,camera:this.getCameraState(),visibility,center:null};
    this.cameraView='iso';
    this.applyInspectionVisibility(); this.fitInspection(); this.shadowsDirty=true; this.dirty=true; this.render(true); return true;
  }

  endInspection() {
    if (!this.inspection) return false;
    const saved=this.inspection; this.inspection=null;
    saved.visibility.forEach((visible,node)=>{ node.visible=visible; });
    this.spring.setInspection(null);
    const damping=this.controls.enableDamping; this.controls.enableDamping=false; this.controls.update();
    this.camera.position.fromArray(saved.camera.position); this.camera.zoom=saved.camera.zoom;
    this.cameraView=saved.camera.view; this.camera.updateProjectionMatrix();
    this.controls.target.fromArray(saved.camera.target); this.controls.update(); this.controls.enableDamping=damping;
    this.grid.visible=this.studioMode==='technical';
    this.contactShadow.visible=this.componentFocus!=='suspension'&&this.lastState?.contact!==false;
    this.setOptions(this.options); this.shadowsDirty=true; this.dirty=true; this.render(true); return true;
  }

  applyInspectionVisibility() {
    if (!this.inspection) return;
    this.inspection.visibility.forEach((_,node)=>{ node.visible=false; });
    this.linkGroup.visible=true; this.spring.group.visible=true;
    this.spring.setInspection(this.inspection.id);
  }

  inspectionBounds() {
    this.spring.group.updateWorldMatrix(true,true);
    const bounds=new THREE.Box3();
    const chamberNames=new Set(['hollow-damper-envelope-section','representative-piston-head','machined-rod-guide-section','rod-wiper-seal-section','damper-base-cap']);
    this.spring.group.traverseVisible(node=>{ if(node.isMesh && (this.inspection?.id!=='damper'||chamberNames.has(node.name))) bounds.union(new THREE.Box3().setFromObject(node)); });
    return bounds;
  }

  fitInspection() {
    if (!this.inspection) return;
    const bounds=this.inspectionBounds(); if(bounds.isEmpty()) return;
    const target=bounds.getCenter(new THREE.Vector3());
    const direction=this.inspection.view==='side' ? new THREE.Vector3(-1,.14,0).normalize() : this.inspection.view==='front' ? new THREE.Vector3(0,.14,1).normalize() : new THREE.Vector3(-1,.14,.45).applyQuaternion(this.spring.group.quaternion).normalize();
    const right=new THREE.Vector3().crossVectors(UP,direction).normalize(),vertical=new THREE.Vector3().crossVectors(direction,right).normalize();
    const ty=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)),tx=ty*this.camera.aspect; let distance=.30;
    for(const x of [bounds.min.x,bounds.max.x]) for(const y of [bounds.min.y,bounds.max.y]) for(const z of [bounds.min.z,bounds.max.z]) {
      const delta=new THREE.Vector3(x,y,z).sub(target); distance=Math.max(distance,Math.abs(delta.dot(right))/tx+delta.dot(direction),Math.abs(delta.dot(vertical))/ty+delta.dot(direction));
    }
    this.camera.zoom=1; this.camera.updateProjectionMatrix(); this.camera.position.copy(target).addScaledVector(direction,distance*1.16);
    this.controls.target.copy(target); this.controls.update(); this.inspection.center=target;
  }

  setQuality(quality='high') {
    this.quality=['standard','high','ultra'].includes(quality) ? quality : 'high';
    this.resize(); this.dirty=true;
  }

  setStudioMode(mode='studio') {
    this.studioMode=mode==='technical'?'technical':'studio';
    const technical=this.studioMode==='technical';
    this.scene.background.set(technical?0xdce6ed:0x0b131d); this.scene.fog.color.copy(this.scene.background);
    this.scene.fog.density=technical?.034:.065;
    this.environment=this.environments[this.studioMode]; this.scene.environment=this.environment.texture;
    this.floorMaterial.color.set(technical?0x8597a6:0x101720); this.floorMaterial.roughness=technical?.88:.64; this.floorMaterial.metalness=technical?.03:.18;
    this.grid.visible=technical;
    this.hemiLight.intensity=technical?.85:.52; this.keyLight.intensity=technical?2.25:2.35;
    this.rimLight.intensity=technical?.85:1.55; this.fillLight.intensity=technical?.60:.40; this.frontFill.intensity=technical?.35:.45;
    this.renderer.toneMappingExposure=technical?.86:1.04;
    this.applyInspectionVisibility();
    this.configureEffects(); this.dirty=true; this.render(true);
    return this.studioMode;
  }

  setComponentFocus(focus='all') {
    this.endInspection();
    this.componentFocus=['all','wheel','suspension'].includes(focus)?focus:'all';
    // Removing the wheel only in suspension inspection exposes the upright's
    // ball joints and all five rods without changing simulated geometry.
    this.wheel.visible=this.componentFocus!=='suspension';
    this.contactShadow.visible=this.componentFocus!=='suspension'&&this.lastState?.contact!==false; this.shadowsDirty=true;
    this.setOptions(this.options); this.fitComponent(); this.dirty=true; this.render(true);
    return this.componentFocus;
  }

  fitComponent() {
    if (this.inspection) { this.fitInspection(); return; }
    if (!this.rig || !this.wheel) return;
    this.scene.updateMatrixWorld(true);
    const focus=this.componentFocus || 'all';
    const bounds=new THREE.Box3(), occupied=[];
    if(focus==='wheel') { bounds.setFromObject(this.wheel); occupied.push(bounds); }
    else if(focus==='suspension') {
      bounds.setFromObject(this.linkGroup); bounds.expandByPoint(new THREE.Vector3(0,this.config.tireRadius+.73,-.85));
      occupied.push(bounds);
    } else {
      bounds.setFromObject(this.rig); bounds.union(new THREE.Box3().setFromObject(this.linkGroup));
      for(const component of [this.holder,this.wheel,this.linkGroup]) occupied.push(new THREE.Box3().setFromObject(component));
    }
    if(bounds.isEmpty()) return;
    const target=bounds.getCenter(new THREE.Vector3());
    const view=this.cameraView || 'iso';
    const orientations={iso:focus==='wheel'?[-.44,.26,.86]:focus==='suspension'?[-.95,.25,.34]:[-.72,.26,.63],side:[-1,.14,0],front:[0,.14,1]};
    const direction=vector(orientations[view]).normalize(), right=new THREE.Vector3().crossVectors(UP,direction).normalize(), vertical=new THREE.Vector3().crossVectors(direction,right).normalize();
    const tangentY=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)), tangentX=tangentY*this.camera.aspect;
    let distance=0;
    for(const occupiedBox of occupied) for(const x of [occupiedBox.min.x,occupiedBox.max.x]) for(const y of [occupiedBox.min.y,occupiedBox.max.y]) for(const z of [occupiedBox.min.z,occupiedBox.max.z]) {
      const delta=new THREE.Vector3(x,y,z).sub(target), depth=delta.dot(direction);
      distance=Math.max(distance,Math.abs(delta.dot(right))/tangentX+depth,Math.abs(delta.dot(vertical))/tangentY+depth);
    }
    distance=Math.max(.65,distance*(focus==='all'?1.10:1.18));
    this.camera.position.copy(target).addScaledVector(direction,distance); this.controls.target.copy(target); this.controls.update();
    this.fitBounds={min:bounds.min.toArray(),max:bounds.max.toArray(),distance}; this.needsFit=false;
  }

  configureEffects() {
    const width=this.container.clientWidth || 800, mobile=width<680;
    const ao=this.quality!=='standard' && this.studioMode==='studio' && !mobile;
    this.postprocessingEnabled=ao;
    this.scene.environmentIntensity=this.studioMode==='technical'?.52:this.quality==='standard'?.70:.85;
    this.renderer.shadowMap.enabled=this.quality!=='standard';
    const shadowSize=this.quality==='ultra'&&!mobile?4096:2048;
    if(this.keyLight.shadow.mapSize.x!==shadowSize) {
      this.keyLight.shadow.map?.dispose(); this.keyLight.shadow.map=null; this.keyLight.shadow.mapSize.set(shadowSize,shadowSize);
    }
    this.shadowsDirty=true;
    this.contactShadow.material.opacity=this.quality==='standard'?.65:.24;
    if(ao) {
      const kernel=this.quality==='ultra'?32:16;
      if(!this.composer || this.aoKernel!==kernel) {
        if(this.composer) { this.composer.passes.forEach(pass=>pass.dispose?.()); this.composer.dispose(); }
        this.composer=new EffectComposer(this.renderer);
        this.composer.renderTarget1.samples=4; this.composer.renderTarget2.samples=4;
        this.composer.addPass(new RenderPass(this.scene,this.camera));
        this.ssao=new ModelSSAOPass(this.scene,this.camera,512,512,kernel); this.ssao.kernelRadius=.065; this.ssao.minDistance=.00006; this.ssao.maxDistance=.008;
        this.composer.addPass(this.ssao); this.composer.addPass(new OutputPass()); this.aoKernel=kernel;
      }
      const {width:renderWidth,height:renderHeight}=this.container.getBoundingClientRect();
      this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(Math.max(1,renderWidth),Math.max(1,renderHeight));
    }
  }

  capturePNG() {
    this.dirty=true; this.render(true); return this.renderer.domElement.toDataURL('image/png');
  }

  clampAnnotations() {
    if(!this.labelGroup.visible) return;
    this.camera.updateMatrixWorld(true);
    const tangent=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)), height=this.container.clientHeight||640,width=this.container.clientWidth||800;
    const top=1-140/height,bottom=-1+100/height;
    for(const sprite of [this.holderLabel,this.linkLabel,this.springLabel,this.hubLabel,this.beltMark]) {
      const view=this.labelViewVector; sprite.getWorldPosition(view); view.applyMatrix4(this.camera.matrixWorldInverse);
      if(view.z>=0) continue;
      const original=sprite.userData.displayScale; if(original) sprite.scale.fromArray(original);
      const pixels=sprite.scale.x*width/(-view.z*tangent*this.camera.aspect*2),maxPixels=Math.min(220,width*.40);
      if(pixels>maxPixels) sprite.scale.multiplyScalar(maxPixels/pixels);
      const halfWidth=sprite.scale.x/(-view.z*tangent*this.camera.aspect*2),halfHeight=sprite.scale.y/(-view.z*tangent*2);
      view.applyMatrix4(this.camera.projectionMatrix);
      const x=THREE.MathUtils.clamp(view.x,-.96+halfWidth,.96-halfWidth),y=THREE.MathUtils.clamp(view.y,bottom+halfHeight,top-halfHeight);
      sprite.center.set(.5+(view.x-x)/(halfWidth*2),.5+(view.y-y)/(halfHeight*2));
    }
  }

  async exportGLB() {
    this.scene.updateMatrixWorld(true);
    const exported=new THREE.Scene(); exported.name='Suspension Lab / current assembly';
    const datumOffset=(this.lastState?.bodyY||0)-(this.config.sprungMass+this.config.unsprungMass)*GRAVITY/this.config.tireRate;
    exported.userData={
      format:'suspension-lab/glb-v1',units:'m',unitSystem:'SI',quantityUnits:{length:'m',mass:'kg',time:'s',force:'N',springRate:'N/m',damping:'N s/m'},
      coordinateSystem:'Right-handed, Y up, X belt length, Z wheel axle; moving road travels toward -X.',
      configUnits:{speed:'km/h',airPressure:'bar gauge',airVolume:'L',tireRadius:'m',roadHeight:'m',roadWidth:'m',roadSpacing:'m',springRate:'N/m',compressionDamping:'N s/m',reboundDamping:'N s/m',airArea:'m^2',timeScale:'dimensionless',motionRatio:'dimensionless'},
      model:'Vertical quarter-car dynamics with illustrated suspension geometry',
      scope:'Current static display pose; no multibody solver, lateral compliance, stress analysis, or exported animation.',
      geometryLimits:'Illustrative geometry, not a validated CAD assembly. Multilink rods use equivalent front-view closure; individual spatial link lengths are not constrained. Tire is a rigid visual surface with hub translation for equilibrium deflection.',
      linkageDescription:this.lastGeometry?.description || '',
      kinematics:this.lastGeometry?{camberDegrees:this.lastGeometry.camber,toeDegrees:this.lastGeometry.toe,valid:this.lastGeometry.valid,displayDatumOffsetY:datumOffset,points:this.lastGeometry.points.map(point=>({id:point.id,kind:point.kind,positionMetres:point.position.map((value,axis)=>axis===1?value+datumOffset:value)})),links:this.lastGeometry.links.map(link=>({...link}))}:null,
      config:{...this.config},state:{...(this.lastState || {})},components:[...this.components],
      presentation:{studioMode:this.studioMode,quality:this.quality,inspection:this.componentFocus},
      exportIncludes:'Full selected assembly, moving-road surface and fixture; independent of inspection visibility.',
    };
    const geometryCopies=new Map(),materialCopies=new Map(),textureCopies=new Map();
    const copyMaterial=material=>{
      if(!materialCopies.has(material)) {
        const copy=material.clone(); copy.userData={};
        for(const key of ['map','normalMap','bumpMap','roughnessMap','metalnessMap','aoMap','emissiveMap','alphaMap']) if(copy[key]) {
          if(!textureCopies.has(copy[key])) textureCopies.set(copy[key],copy[key].clone()); copy[key]=textureCopies.get(copy[key]);
        }
        materialCopies.set(material,copy);
      }
      return materialCopies.get(material);
    };
    try {
      for(const source of [this.rig,this.linkGroup,this.testBench,this.roadMesh,this.beltEdge]) {
        const cloned=source.clone(true); cloned.visible=true;
        cloned.traverse(object=>{
          if(object.isSprite || object.isLine || object.isLight) { object.visible=false; return; }
          if(object.userData.presentationOnly) { object.visible=false; return; }
          if(object.userData.assemblyVisible!==undefined) object.visible=object.userData.assemblyVisible;
          if(!object.isMesh) return;
          if(!geometryCopies.has(object.geometry)) geometryCopies.set(object.geometry,object.geometry.clone());
          object.geometry=geometryCopies.get(object.geometry);
          object.material=Array.isArray(object.material)?object.material.map(copyMaterial):copyMaterial(object.material);
          if(object.name==='wheel-and-brake') object.visible=true;
        });
        // The wheel group is nested inside the rig and may be hidden in inspection.
        cloned.getObjectByName('wheel-and-brake')?.traverse(o=>{ if(o.name==='wheel-and-brake') o.visible=true; });
        if(source===this.linkGroup && this.inspection) for(let i=0;i<source.children.length;i++) {
          cloned.children[i].visible=this.inspection.visibility.get(source.children[i]) ?? true;
        }
        exported.add(cloned);
      }
      const arrayBuffer=await new GLTFExporter().parseAsync(exported,{binary:true,onlyVisible:true,trs:false,maxTextureSize:1024});
      this.exportCount++; return arrayBuffer;
    } finally {
      geometryCopies.forEach(geometry=>geometry.dispose()); textureCopies.forEach(texture=>texture.dispose()); materialCopies.forEach(material=>material.dispose()); exported.clear();
    }
  }

  resize() {
    const {width,height}=this.container.getBoundingClientRect(); if(!width||!height) return;
    // Keep the road annotation inside the narrow viewport while preserving the desktop layout.
    this.beltMark.position.set(width < 640 ? -.18 : .20, .12, width < 640 ? .28 : .40);
    const pixelCap=width<680?1.35:this.quality==='ultra'?2.0:this.quality==='high'?1.65:1.0;
    const ratio=Math.min(window.devicePixelRatio*(this.quality==='ultra'?1.25:1),pixelCap);
    this.renderer.setPixelRatio(ratio);
    const previousAspect=this.camera.aspect;
    this.camera.aspect=width/height;
    this.camera.fov=width/height<.85?47:34; this.camera.updateProjectionMatrix(); this.renderer.setSize(width,height);
    this.configureEffects(); if(this.componentFocus!=='all'||this.needsFit||Math.abs(previousAspect-this.camera.aspect)>.20) this.fitComponent();
    this.dirty=true; this.render(true);
  }

  update(state,config) {
    if(this.lastStateTime===state.time&&this.lastGeometry) { this.controls.update(); if(this.dirty) this.render(); return this.lastGeometry; }
    const firstPose=!this.lastGeometry; this.lastState={...state}; this.lastStateTime=state.time; const body=state.bodyY||0,geom=getGeometry(config,state.travel||0); this.lastGeometry=geom;
    const tireDeflection=(config.sprungMass+config.unsprungMass)*GRAVITY/config.tireRate;
    const point=(p)=>[p[0],p[1]+body-tireDeflection,p[2]];
    const points=Object.fromEntries(geom.points.map(p=>[p.id,point(p.position)]));
    this.holder.position.y=body-tireDeflection; this.holderLabel.position.y=this.holderHeight+body-tireDeflection;
    const hub=point(geom.hub); this.wheel.position.set(...hub);
    this.wheel.rotation.set(THREE.MathUtils.degToRad(geom.camber||0),THREE.MathUtils.degToRad(geom.toe||0),0); this.spin.rotation.z=-state.distance/config.tireRadius;
    align(this.axle,[hub[0],hub[1],hub[2]-.25],hub,true);
    align(this.knuckle,points['lower-ball'],points['upper-ball']);
    const uprightLength=vector(points['upper-ball']).sub(vector(points['lower-ball'])).length();
    this.upright.scale.y=uprightLength; this.knuckleSpine.scale.y=uprightLength*.82;
    this.carrier.position.set(...hub); this.carrier.rotation.copy(this.wheel.rotation);
    for(const link of this.linkParts) if(points[link.a]&&points[link.b]) link.assembly.update(points[link.a],points[link.b]);
    for(const joint of this.joints) if(points[joint.id]) joint.mesh.position.set(...points[joint.id]);
    for(const web of this.webs) web.part.update(...web.ids.map(id=>points[id]));
    for(const bar of this.crossbars) align(bar.mesh,...bar.ids.map(id=>points[id]),true);
    const a=point(geom.springTop),b=point(geom.springBottom); this.spring.update(a,b);
    this.linkLabel.position.y=config.tireRadius+.12+body-tireDeflection; this.springLabel.position.y=config.tireRadius+.78+body-tireDeflection; this.hubLabel.position.y=hub[1]+config.tireRadius*1.14;
    this.labelLeaders.forEach(line=>{line.position.y=body-tireDeflection;});
    const position=this.roadMesh.geometry.attributes.position,edge=this.beltEdge.geometry.attributes.position;
    for(let i=0;i<position.count;i+=2) {
      const height=roadHeight(position.getX(i)+state.distance,config); position.setY(i,height); position.setY(i+1,height); edge.setY(i,height-.002);
    }
    position.needsUpdate=true; edge.needsUpdate=true; this.roadMesh.geometry.computeVertexNormals(); this.beltEdge.geometry.computeVertexNormals();
    this.beltTexture.offset.x=state.distance/7.2*26; this.rollers.forEach(roller=>{roller.rotation.y=state.distance/.116;});
    this.contactShadow.position.set(hub[0],(state.rawRoadY||0)+.0015,hub[2]); this.contactShadow.visible=state.contact!==false&&this.componentFocus!=='suspension';
    this.contactArrow.position.set(hub[0],state.rawRoadY||0,.23); this.contactArrow.setLength(Math.min(.85,Math.max(.02,state.contactForce/9000)),.055,.026);
    this.springArrow.position.set(...b); this.springArrow.setDirection(vector(a).sub(vector(b)).normalize()); this.springArrow.setLength(Math.min(.8,Math.max(.02,Math.abs(state.springForce)/7000)),.055,.026);
    if(this.inspection) {
      this.applyInspectionVisibility();
      const center=this.inspectionBounds().getCenter(new THREE.Vector3());
      if(this.inspection.center) { const delta=center.clone().sub(this.inspection.center); this.camera.position.add(delta); this.controls.target.add(delta); }
      this.inspection.center=center;
    }
    this.shadowsDirty=true; if(firstPose||this.needsFit) this.fitComponent();
    this.controls.update(); this.dirty=true; this.render(); return geom;
  }

  getDiagnostics() {
    const now=performance.now();
    const visible=node=>{ for(let current=node;current;current=current.parent) if(!current.visible) return false; return true; };
    const actualVisible={wheel:visible(this.wheel),road:visible(this.roadMesh),fixture:visible(this.rig),floor:visible(this.floor),grid:visible(this.grid),labels:visible(this.labelGroup),forces:visible(this.forceGroup),links:visible(this.linkGroup),spring:visible(this.spring.group)};
    actualVisible.otherLinks=this.linkGroup.children.some(node=>node!==this.spring.group&&visible(node));
    return { actualVisible,inspection:this.getInspection(),camera:this.getCameraState(),mechanical:this.spring.getDiagnostics(),structure:this.config.structure,springType:this.config.springType,quality:this.quality,studioMode:this.studioMode,componentFocus:this.componentFocus,components:[...this.components],triangles:this.renderer.info.render.triangles,draws:this.renderer.info.render.calls,geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures,coilBufferVertices:this.spring.coilGeometry.attributes.position.count,pixelRatio:this.renderer.getPixelRatio(),canvas:{width:this.renderer.domElement.width,height:this.renderer.domElement.height},shadowEnabled:this.renderer.shadowMap.enabled,shadowMapSize:this.renderer.shadowMap.enabled?this.keyLight.shadow.mapSize.x:0,environmentIntensity:this.scene.environmentIntensity,postprocessing:{ssao:this.postprocessingEnabled,samples:this.postprocessingEnabled?this.aoKernel:0,multisample:this.postprocessingEnabled?4:0},fpsLimit:60,renderCount:this.renderCount,framesLastSecond:this.frameTimes.filter(time=>now-time<=1000).length,cpuRenderMs:this.cpuRenderMs,exportCount:this.exportCount,fitBounds:this.fitBounds,wheelVisible:this.wheel.visible,model:'quarter-car vertical / illustrative linkage',units:'m',topology:{aArms:this.webs.length,rods:this.linkParts.filter(p=>p.assembly.group.name.includes('rod')).length,chassisMounts:this.mounts.length,struts:this.config.structure==='macpherson'?1:0} };
  }

  render(force=false) {
    if(!this.renderer||!this.camera||(!this.dirty&&!force)) return false;
    const now=performance.now(); if(!force&&now-this.lastRenderAt<1000/60-.5) return false;
    this.lastRenderAt=now; this.renderer.info.reset();
    this.clampAnnotations();
    this.renderer.shadowMap.needsUpdate=this.shadowsDirty;
    this.camera.layers.set(0);
    if(this.postprocessingEnabled&&this.composer) this.composer.render(); else this.renderer.render(this.scene,this.camera);
    // Callouts and force arrows are composited after the physically lit model,
    // so SSAO never treats an annotation as part of the suspension geometry.
    const background=this.scene.background,autoClear=this.renderer.autoClear;
    this.renderer.autoClear=false; this.scene.background=null; this.renderer.clearDepth(); this.camera.layers.set(1); this.renderer.render(this.scene,this.camera);
    this.scene.background=background; this.renderer.autoClear=autoClear; this.camera.layers.set(0);
    this.shadowsDirty=false;
    this.cpuRenderMs=performance.now()-now; this.renderCount++; this.frameTimes.push(now);
    while(this.frameTimes.length&&now-this.frameTimes[0]>1000) this.frameTimes.shift();
    this.dirty=false; return true;
  }
}
