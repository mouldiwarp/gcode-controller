// three.js scene for the toolpath. Z is up, units are mm, everything is drawn
// in work coordinates (the machine envelope is shifted by the work offset).
// Rendering is on demand: nothing redraws unless something changed.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bounds, Segment, Vec3 } from '@gcc/shared';

const C = {
  feed: new THREE.Color('#9a9a9a'),
  rapid: new THREE.Color('#4a4a4a'),
  feedDone: new THREE.Color('#c5a059'),
  rapidDone: new THREE.Color('#6b5a35'),
  grid: new THREE.Color('#262626'),
  gridMajor: new THREE.Color('#333333'),
  envelope: new THREE.Color('#3d3d3d'),
  tool: new THREE.Color('#d8b672'),
};

export type ViewName = 'iso' | 'top' | 'front' | 'right';

export class ToolpathScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private paths?: THREE.LineSegments;
  private colors?: THREE.BufferAttribute;
  private segLines: Int32Array = new Int32Array();
  private segRapid: Uint8Array = new Uint8Array();
  private doneCount = 0;
  private grid?: THREE.Group;
  private envelope?: THREE.Box3Helper;
  private axes: THREE.Group;
  private tool: THREE.Mesh;
  private bounds: Bounds | null = null;
  private frame = 0;
  private ro: ResizeObserver;
  private view: ViewName = 'iso';

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.axes = this.makeAxes(20);
    this.scene.add(this.axes);

    const toolGeo = new THREE.ConeGeometry(1, 4, 24);
    toolGeo.rotateX(-Math.PI / 2);
    toolGeo.translate(0, 0, 2);
    this.tool = new THREE.Mesh(toolGeo, new THREE.MeshBasicMaterial({ color: C.tool, transparent: true, opacity: 0.9 }));
    this.scene.add(this.tool);

    this.setGrid({ min: [0, 0, 0], max: [100, 100, 0] });
    this.fit();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  dispose(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const first = this.camera.aspect === 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (first) this.setView(this.view);
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  private makeAxes(len: number): THREE.Group {
    const g = new THREE.Group();
    const mk = (to: Vec3, color: string) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
      g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
    };
    mk([len, 0, 0], '#d96b6b');
    mk([0, len, 0], '#7fbf6a');
    mk([0, 0, len], '#6a9fd9');
    return g;
  }

  private setGrid(b: Bounds): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.traverse((o) => (o as THREE.LineSegments).geometry?.dispose());
    }
    const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 50);
    const step = ext > 1500 ? 100 : ext > 300 ? 50 : 10;
    const pad = step * 2;
    const x0 = Math.floor((Math.min(b.min[0], 0) - pad) / step) * step;
    const x1 = Math.ceil((Math.max(b.max[0], 0) + pad) / step) * step;
    const y0 = Math.floor((Math.min(b.min[1], 0) - pad) / step) * step;
    const y1 = Math.ceil((Math.max(b.max[1], 0) + pad) / step) * step;
    const minor: number[] = [];
    const major: number[] = [];
    for (let x = x0; x <= x1; x += step) (x % (step * 5) === 0 ? major : minor).push(x, y0, 0, x, y1, 0);
    for (let y = y0; y <= y1; y += step) (y % (step * 5) === 0 ? major : minor).push(x0, y, 0, x1, y, 0);
    const g = new THREE.Group();
    const add = (pts: number[], color: THREE.Color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color })));
    };
    add(minor, C.grid);
    add(major, C.gridMajor);
    g.position.z = -0.01;
    this.grid = g;
    this.scene.add(g);
  }

  setProgram(segments: Segment[] | null, bounds: Bounds | null): void {
    if (this.paths) {
      this.scene.remove(this.paths);
      this.paths.geometry.dispose();
      (this.paths.material as THREE.Material).dispose();
      this.paths = undefined;
    }
    this.bounds = bounds;
    this.doneCount = 0;
    if (segments && segments.length) {
      const n = segments.length;
      const pos = new Float32Array(n * 6);
      const col = new Float32Array(n * 6);
      this.segLines = new Int32Array(n);
      this.segRapid = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = segments[i];
        pos.set(s.from, i * 6);
        pos.set(s.to, i * 6 + 3);
        const c = s.type === 'rapid' ? C.rapid : C.feed;
        col[i * 6] = col[i * 6 + 3] = c.r;
        col[i * 6 + 1] = col[i * 6 + 4] = c.g;
        col[i * 6 + 2] = col[i * 6 + 5] = c.b;
        this.segLines[i] = s.line;
        this.segRapid[i] = s.type === 'rapid' ? 1 : 0;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.colors = new THREE.BufferAttribute(col, 3);
      this.colors.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('color', this.colors);
      this.paths = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.scene.add(this.paths);
    }
    this.setGrid(bounds ?? { min: [0, 0, 0], max: [100, 100, 0] });
    const diag = bounds ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) : 100;
    const k = Math.max(diag / 60, 1.2);
    this.tool.scale.set(k, k, k);
    this.axes.scale.setScalar(Math.max(diag / 120, 0.5));
    this.setView(this.view);
  }

  /** Colour every segment from source lines <= `line` as done. */
  setProgress(line: number): void {
    if (!this.paths || !this.colors) return;
    // Segments are in source order, so find the first one past `line`.
    let lo = 0;
    let hi = this.segLines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segLines[mid] <= line) lo = mid + 1;
      else hi = mid;
    }
    const target = lo;
    if (target === this.doneCount) return;
    const arr = this.colors.array as Float32Array;
    const from = Math.min(target, this.doneCount);
    const to = Math.max(target, this.doneCount);
    const done = target > this.doneCount;
    for (let i = from; i < to; i++) {
      const c = this.segRapid[i] ? (done ? C.rapidDone : C.rapid) : done ? C.feedDone : C.feed;
      arr[i * 6] = arr[i * 6 + 3] = c.r;
      arr[i * 6 + 1] = arr[i * 6 + 4] = c.g;
      arr[i * 6 + 2] = arr[i * 6 + 5] = c.b;
    }
    this.colors.clearUpdateRanges();
    this.colors.addUpdateRange(from * 6, (to - from) * 6);
    this.colors.needsUpdate = true;
    this.doneCount = target;
    this.requestRender();
  }

  setTool(p: Vec3 | null): void {
    this.tool.visible = !!p;
    if (p) this.tool.position.set(p[0], p[1], p[2]);
    this.requestRender();
  }

  setEnvelope(env: Bounds | null): void {
    if (this.envelope) {
      this.scene.remove(this.envelope);
      this.envelope.geometry.dispose();
      this.envelope = undefined;
    }
    if (env) {
      const box = new THREE.Box3(new THREE.Vector3(...env.min), new THREE.Vector3(...env.max));
      this.envelope = new THREE.Box3Helper(box, C.envelope);
      this.scene.add(this.envelope);
    }
    this.requestRender();
  }

  fit(): void {
    this.setView(this.view);
  }

  setView(view: ViewName): void {
    this.view = view;
    const b = this.bounds ?? { min: [0, 0, 0] as Vec3, max: [100, 100, 10] as Vec3 };
    const center = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const radius = Math.max(new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).length() / 2, 10);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
    const dirs: Record<ViewName, THREE.Vector3> = {
      iso: new THREE.Vector3(0.75, -1.15, 1.0),
      top: new THREE.Vector3(0, -0.0001, 1),
      front: new THREE.Vector3(0, -1, 0.0001),
      right: new THREE.Vector3(1, 0, 0.0001),
    };
    const dir = dirs[view].normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.05);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }
}
