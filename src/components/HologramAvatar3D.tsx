import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeSpeechEnvelope } from '../lib/hologramSpeech';

interface HologramAvatar3DProps {
  isSpeaking: boolean;
  isThinking: boolean;
  isLiveConnected: boolean;
  amplitude: number;
  sentimentScore: number;
}

const COLOR_CYAN = new THREE.Color('#38bdf8');
const COLOR_BLUE = new THREE.Color('#2563eb');
const COLOR_MINT = new THREE.Color('#34d399');
const COLOR_AMBER = new THREE.Color('#fb923c');
const TARGET_PRIMARY = new THREE.Color();
const TARGET_ACCENT = new THREE.Color();

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function HologramAvatar3D({
  isSpeaking,
  isThinking,
  isLiveConnected,
  amplitude,
  sentimentScore,
}: HologramAvatar3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [webglReady, setWebglReady] = useState(true);

  const liveStateRef = useRef({
    isSpeaking,
    isThinking,
    isLiveConnected,
    amplitude,
    sentimentScore,
  });

  useEffect(() => {
    liveStateRef.current = {
      isSpeaking,
      isThinking,
      isLiveConnected,
      amplitude,
      sentimentScore,
    };
  }, [isSpeaking, isThinking, isLiveConnected, amplitude, sentimentScore]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglReady(false);
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x020617, 0);

    const width = Math.max(120, container.clientWidth || 168);
    const height = Math.max(120, container.clientHeight || 152);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 25);
    camera.position.set(0, 0.28, 3.35);
    camera.lookAt(0, 0.05, 0);

    // Studio environment reflection for metallic emitter base
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmremGenerator.dispose();

    // 3-Point studio + emitter lighting rig
    const hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x0f172a, 1.15);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xe0f2fe, 1.8);
    keyLight.position.set(2.2, 3.0, 2.5);
    scene.add(keyLight);

    const emitterLight = new THREE.PointLight(0x38bdf8, 2.2, 6, 1.5);
    emitterLight.position.set(0, -0.78, 0.45);
    scene.add(emitterLight);

    const disposables: Array<{ dispose: () => void }> = [envTarget.texture];

    // 1. Metallic Emitter Pedestal + Glowing Lens Ring
    const pedestalGroup = new THREE.Group();
    pedestalGroup.position.y = -0.92;
    scene.add(pedestalGroup);

    const baseGeo = new THREE.CylinderGeometry(0.62, 0.74, 0.14, 32);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.92,
      roughness: 0.22,
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    pedestalGroup.add(baseMesh);

    const collarGeo = new THREE.TorusGeometry(0.58, 0.032, 12, 40);
    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 1.4,
      metalness: 0.8,
      roughness: 0.18,
    });
    const collarMesh = new THREE.Mesh(collarGeo, collarMat);
    collarMesh.rotation.x = Math.PI / 2;
    collarMesh.position.y = 0.07;
    pedestalGroup.add(collarMesh);

    const lensGeo = new THREE.CircleGeometry(0.54, 32);
    const lensMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lensMesh = new THREE.Mesh(lensGeo, lensMat);
    lensMesh.rotation.x = -Math.PI / 2;
    lensMesh.position.y = 0.075;
    pedestalGroup.add(lensMesh);

    disposables.push(baseGeo, baseMat, collarGeo, collarMat, lensGeo, lensMat);

    // 2. Volumetric Projection Beam Shader Cone
    const beamGeo = new THREE.CylinderGeometry(0.95, 0.48, 1.55, 32, 1, true);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#38bdf8') },
        uIntensity: { value: 0.35 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          float fadeY = pow(1.0 - vUv.y, 1.7) * smoothstep(0.0, 0.15, vUv.y);
          float scan = 0.72 + 0.28 * sin(vUv.y * 42.0 - uTime * 4.5);
          float alpha = fadeY * scan * uIntensity * 0.38;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.position.y = -0.12;
    scene.add(beamMesh);
    disposables.push(beamGeo, beamMat);

    // 3. Composite 3D Holographic Agent Head & Shoulders Group
    const headRoot = new THREE.Group();
    headRoot.position.y = 0.12;
    scene.add(headRoot);

    // Sculpted Lathe cranium + upper neck bust
    const lathePoints = [
      new THREE.Vector2(0.01, -0.58),
      new THREE.Vector2(0.32, -0.56),
      new THREE.Vector2(0.22, -0.44),
      new THREE.Vector2(0.18, -0.34),
      new THREE.Vector2(0.33, -0.22),
      new THREE.Vector2(0.42, -0.02),
      new THREE.Vector2(0.43, 0.18),
      new THREE.Vector2(0.36, 0.38),
      new THREE.Vector2(0.2, 0.5),
      new THREE.Vector2(0.01, 0.53),
    ];
    const headGeo = new THREE.LatheGeometry(lathePoints, 28);
    const holoShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpeakLevel: { value: 0 },
        uColorPrimary: { value: new THREE.Color('#0ea5e9') },
        uColorRim: { value: new THREE.Color('#7dd3fc') },
      },
      vertexShader: `
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying vec3 vLocalPos;
        uniform float uTime;
        uniform float uSpeakLevel;
        void main() {
          vLocalPos = position;
          vec3 pos = position;
          float ripple = sin(position.y * 18.0 - uTime * 11.0) * 0.008 * uSpeakLevel;
          pos += normal * ripple;
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          vViewPos = -mvPosition.xyz;
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uSpeakLevel;
        uniform vec3 uColorPrimary;
        uniform vec3 uColorRim;
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying vec3 vLocalPos;
        void main() {
          vec3 viewDir = normalize(vViewPos);
          float fresnel = pow(1.0 - max(0.0, abs(dot(viewDir, vNormalView))), 2.1);
          float scanlines = 0.68 + 0.32 * sin(vLocalPos.y * 68.0 - uTime * 5.2);
          float glitchBand = smoothstep(0.92, 1.0, sin(vLocalPos.y * 8.0 - uTime * 2.4));
          vec3 col = mix(uColorPrimary, uColorRim, clamp(fresnel * 1.15 + uSpeakLevel * 0.35 + glitchBand * 0.25, 0.0, 1.0));
          float alpha = clamp((0.26 + fresnel * 0.68 + uSpeakLevel * 0.14) * scanlines, 0.18, 0.94);
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const headMesh = new THREE.Mesh(headGeo, holoShaderMat);
    headRoot.add(headMesh);

    // Subtle faceted wireframe halo over head
    const wireGeo = new THREE.IcosahedronGeometry(0.47, 1);
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      wireframe: true,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const wireMesh = new THREE.Mesh(wireGeo, wireMat);
    wireMesh.position.y = 0.08;
    wireMesh.scale.set(0.96, 1.14, 0.98);
    headRoot.add(wireMesh);

    // 4. Curved Visor + Optical Eyes
    const visorGeo = new THREE.CylinderGeometry(0.44, 0.43, 0.13, 24, 1, true, -0.75, 1.5);
    const visorMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 0.16, 0.02);
    headRoot.add(visorMesh);

    const eyeGeo = new THREE.CapsuleGeometry(0.032, 0.065, 4, 8);
    const eyeMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.95,
    });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.rotation.z = Math.PI / 2;
    leftEye.position.set(-0.14, 0.16, 0.41);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.rotation.z = Math.PI / 2;
    rightEye.position.set(0.14, 0.16, 0.41);
    headRoot.add(leftEye, rightEye);

    // 5. Articulated 3D Oral Voice Equalizer Bars (7 glowing mouth segments)
    const mouthGroup = new THREE.Group();
    mouthGroup.position.set(0, -0.09, 0.42);
    headRoot.add(mouthGroup);

    const barGeo = new THREE.BoxGeometry(0.032, 0.16, 0.03);
    const barMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mouthBars: THREE.Mesh[] = [];
    for (let i = 0; i < 7; i++) {
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.x = (i - 3) * 0.052;
      bar.scale.y = 0.18;
      mouthGroup.add(bar);
      mouthBars.push(bar);
    }

    // 6. Articulated 3D Lower Jaw Plate (pivots down when talking)
    const jawPivot = new THREE.Group();
    jawPivot.position.set(0, -0.11, 0.12);
    headRoot.add(jawPivot);

    const jawGeo = new THREE.BoxGeometry(0.32, 0.12, 0.28);
    const jawMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const jawMesh = new THREE.Mesh(jawGeo, jawMat);
    jawMesh.position.set(0, -0.1, 0.15);
    jawPivot.add(jawMesh);

    disposables.push(
      headGeo,
      holoShaderMat,
      wireGeo,
      wireMat,
      visorGeo,
      visorMat,
      eyeGeo,
      eyeMat,
      barGeo,
      barMat,
      jawGeo,
      jawMat
    );

    // 7. Two Orbital Telemetry Rings + Data Nodes
    const ringOuterGeo = new THREE.TorusGeometry(0.76, 0.012, 8, 56);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringOuter = new THREE.Mesh(ringOuterGeo, ringMat);
    ringOuter.rotation.x = Math.PI / 2.4;
    ringOuter.rotation.y = 0.25;
    scene.add(ringOuter);

    const ringInnerGeo = new THREE.TorusGeometry(0.62, 0.009, 8, 48);
    const ringInnerMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringInner = new THREE.Mesh(ringInnerGeo, ringInnerMat);
    ringInner.rotation.x = -Math.PI / 2.8;
    ringInner.rotation.y = -0.35;
    scene.add(ringInner);

    const nodeGeo = new THREE.SphereGeometry(0.032, 10, 10);
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
    const nodeA = new THREE.Mesh(nodeGeo, nodeMat);
    nodeA.position.x = 0.76;
    ringOuter.add(nodeA);
    const nodeB = new THREE.Mesh(nodeGeo, nodeMat);
    nodeB.position.x = -0.62;
    ringInner.add(nodeB);

    disposables.push(ringOuterGeo, ringMat, ringInnerGeo, ringInnerMat, nodeGeo, nodeMat);

    // 8. Rising Hologram Particles
    const particleCount = 48;
    const particlePositions = new Float32Array(particleCount * 3);
    const particleSpeeds = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const radius = 0.22 + ((i * 17) % 10) * 0.045;
      particlePositions[i * 3] = Math.cos(angle) * radius;
      particlePositions[i * 3 + 1] = -0.82 + ((i * 29) % 16) * 0.1;
      particlePositions[i * 3 + 2] = Math.sin(angle) * radius;
      particleSpeeds[i] = 0.22 + ((i * 13) % 7) * 0.045;
    }
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    const particleMat = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.035,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);
    disposables.push(particleGeo, particleMat);

    // ResizeObserver for responsive container fit
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(120, Math.round(entry.contentRect.width));
        const h = Math.max(120, Math.round(entry.contentRect.height));
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      }
    });
    resizeObserver.observe(container);

    // Animation state (zero GC allocations inside tick)
    let disposed = false;
    let frameId = 0;
    let lastMs = performance.now();
    let elapsed = 0;
    let dampedSpeak = 0;
    let dampedJaw = 0;
    let dampedNod = 0;
    let dampedTurn = 0;
    let dampedRingScale = 1;

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (status === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 6);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 6);
    };

    const tick = () => {
      if (disposed) return;

      const now = performance.now();
      const delta = Math.min(0.1, Math.max(0.001, (now - lastMs) / 1000));
      lastMs = now;
      elapsed += delta;

      const {
        isSpeaking: speakingNow,
        isThinking: thinkingNow,
        isLiveConnected: liveNow,
        amplitude: ampNow,
        sentimentScore: sentNow,
      } = liveStateRef.current;

      const env = computeSpeechEnvelope(elapsed, speakingNow, thinkingNow, ampNow);

      // Exponential damping for physical speech weight
      const targetSpeak = speakingNow ? env.pulse : thinkingNow ? 0.35 : liveNow ? 0.2 : 0.08;
      dampedSpeak = THREE.MathUtils.damp(dampedSpeak, targetSpeak, 11, delta);
      dampedJaw = THREE.MathUtils.damp(dampedJaw, env.jawOpen, 18, delta);
      dampedNod = THREE.MathUtils.damp(dampedNod, env.headNod, 9, delta);
      dampedTurn = THREE.MathUtils.damp(dampedTurn, env.headTurn, 5, delta);
      const targetRingScale = speakingNow ? 1.07 + env.jawOpen * 0.06 : thinkingNow ? 1.03 : 0.96;
      dampedRingScale = THREE.MathUtils.damp(dampedRingScale, targetRingScale, 8, delta);

      // Sentiment-aware hologram tinting (subtle warm amber rim only when urgent/negative)
      if (sentNow <= -0.35) {
        TARGET_PRIMARY.copy(COLOR_BLUE).lerp(COLOR_AMBER, 0.28);
        TARGET_ACCENT.copy(COLOR_CYAN).lerp(COLOR_AMBER, 0.35);
      } else if (sentNow >= 0.45) {
        TARGET_PRIMARY.copy(COLOR_BLUE).lerp(COLOR_MINT, 0.25);
        TARGET_ACCENT.copy(COLOR_CYAN).lerp(COLOR_MINT, 0.35);
      } else {
        TARGET_PRIMARY.copy(COLOR_BLUE);
        TARGET_ACCENT.copy(COLOR_CYAN);
      }

      holoShaderMat.uniforms.uTime.value = elapsed;
      holoShaderMat.uniforms.uSpeakLevel.value = dampedSpeak;
      holoShaderMat.uniforms.uColorPrimary.value.lerp(TARGET_PRIMARY, 0.12);
      holoShaderMat.uniforms.uColorRim.value.lerp(TARGET_ACCENT, 0.12);

      beamMat.uniforms.uTime.value = elapsed;
      beamMat.uniforms.uIntensity.value = 0.25 + dampedSpeak * 0.75;
      beamMat.uniforms.uColor.value.lerp(TARGET_ACCENT, 0.12);

      collarMat.emissive.lerp(TARGET_ACCENT, 0.12);
      collarMat.emissiveIntensity = 0.9 + dampedSpeak * 1.4;
      lensMat.opacity = 0.25 + dampedSpeak * 0.45;
      emitterLight.color.lerp(TARGET_ACCENT, 0.12);
      emitterLight.intensity = 1.6 + dampedSpeak * 1.9;

      // Head hover + natural conversational tilt & nod
      headRoot.position.y = 0.12 + Math.sin(elapsed * 2.1) * 0.032;
      headRoot.rotation.x = dampedNod;
      headRoot.rotation.y = dampedTurn;
      wireMesh.rotation.y = elapsed * (speakingNow ? 0.55 : 0.18);

      // Natural periodic blink (~every 4.2s)
      const blinkCycle = elapsed % 4.2;
      const eyeOpenScale = blinkCycle > 4.02 ? 0.14 : speakingNow ? 1.15 : 1.0;
      leftEye.scale.x = eyeOpenScale;
      rightEye.scale.x = eyeOpenScale;

      // Jaw hinge rotation & mouth bar articulation
      jawPivot.rotation.x = dampedJaw * 0.28;
      for (let i = 0; i < 7; i++) {
        mouthBars[i].scale.y = env.barHeights[i];
      }

      // Orbital rings rotation + radial pulse
      ringOuter.scale.setScalar(dampedRingScale);
      ringInner.scale.setScalar(dampedRingScale * 0.98);
      const ringSpeed = speakingNow ? 1.55 : thinkingNow ? 1.1 : 0.35;
      ringOuter.rotation.z += delta * ringSpeed;
      ringInner.rotation.z -= delta * ringSpeed * 1.3;

      // Rising hologram motes
      const posAttr = particleGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < particleCount; i++) {
        let py = posAttr.getY(i) + particleSpeeds[i] * delta * (speakingNow ? 1.9 : 1.0);
        if (py > 0.78) {
          py = -0.84;
        }
        posAttr.setY(i, py);
      }
      posAttr.needsUpdate = true;

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    tick();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      resizeObserver.disconnect();
      for (const item of disposables) {
        item.dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  const stateLabel = isSpeaking ? 'Speaking' : isThinking ? 'Analyzing' : isLiveConnected ? 'Listening' : 'Standby';

  return (
    <div
      data-testid="hologram-avatar-3d"
      data-speaking={isSpeaking ? 'true' : 'false'}
      data-state={stateLabel.toLowerCase()}
      className="relative h-[144px] w-full sm:w-[164px] shrink-0 rounded-lg bg-slate-900/95 border border-slate-800 overflow-hidden"
    >
      {webglReady ? (
        <div
          ref={containerRef}
          aria-label={`Meridian 3D Hologram Avatar (${stateLabel})`}
          className="w-full h-full"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-xs text-sky-300 font-mono">
          3D Holo Core
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-1.5 flex items-center justify-center">
        <span
          className={`px-2 py-0.5 rounded bg-slate-950/90 border text-[10px] font-mono tracking-wide ${
            isSpeaking
              ? 'border-sky-400/50 text-sky-300'
              : isThinking
              ? 'border-blue-400/40 text-blue-300'
              : 'border-slate-700 text-slate-400'
          }`}
        >
          {stateLabel}
        </span>
      </div>
    </div>
  );
}
