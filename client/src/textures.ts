import * as THREE from 'three';

// Procedural canvas textures (cosmetic only, so Math.random is fine here).

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Weathered, scorched concrete: speckle, formwork seams, rust drips, cracks. 1 tile ≈ 4 m. */
export function concreteTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#6c645b';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 80 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v * 0.93},${v * 0.85},${0.08 + Math.random() * 0.15})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // Formwork seams and tie holes.
  g.strokeStyle = 'rgba(40,32,26,0.35)';
  g.lineWidth = 2;
  for (let y = 128; y < 512; y += 128) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(512, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(30,24,20,0.6)';
  for (let y = 64; y < 512; y += 128) for (let x = 64; x < 512; x += 128) g.fillRect(x - 3, y - 3, 6, 6);
  // Rust and soot drips.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const len = 40 + Math.random() * 160;
    const grad = g.createLinearGradient(x, y, x, y + len);
    const rust = Math.random() < 0.5;
    grad.addColorStop(0, rust ? 'rgba(110,55,25,0.35)' : 'rgba(25,18,15,0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, 2 + Math.random() * 8, len);
  }
  // Soft, broad stains.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 60 + Math.random() * 120;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(45,30,22,0.18)');
    grad.addColorStop(1, 'rgba(45,30,22,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Cracks: jittered random walks.
  g.strokeStyle = 'rgba(20,14,10,0.75)';
  for (let i = 0; i < 14; i++) {
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    g.lineWidth = 1 + Math.random() * 1.5;
    g.beginPath();
    g.moveTo(x, y);
    const dir = Math.random() * Math.PI * 2;
    for (let s = 0; s < 18; s++) {
      x += Math.cos(dir + (Math.random() - 0.5) * 1.6) * 9;
      y += Math.sin(dir + (Math.random() - 0.5) * 1.6) * 9;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return toTexture(c);
}

/** Ruined tower facade: concrete floor bands with dark, partly shattered window openings. 1 tile ≈ 8 m. */
export function facadeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  g.drawImage(concreteTexture().image as HTMLCanvasElement, 0, 0);
  g.fillStyle = 'rgba(20,16,14,0.25)';
  for (let y = 0; y < 512; y += 128) g.fillRect(0, y, 512, 10); // floor slabs
  for (let fy = 0; fy < 4; fy++) {
    for (let fx = 0; fx < 4; fx++) {
      const x = fx * 128 + 18;
      const y = fy * 128 + 30;
      if (Math.random() < 0.12) continue; // bricked up
      g.fillStyle = Math.random() < 0.15 ? '#2a1d14' : '#0d0b0a';
      g.fillRect(x, y, 92, 80);
      // Jagged broken edges
      g.fillStyle = '#5f574e';
      for (let i = 0; i < 6; i++) g.fillRect(x + Math.random() * 92, y + (Math.random() < 0.5 ? 0 : 74), 6 + Math.random() * 14, 6);
    }
  }
  return toTexture(c);
}

/**
 * Alien vines: dark teal strands with leaves (color + alpha) and a matching emissive map of
 * bioluminescent bulbs, so climbable surfaces read from across the maze. 1 tile ≈ 3 m.
 */
export function vineTextures(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const W = 256;
  const H = 512;
  const [c, g] = canvas(W, H);
  const [gc, gg] = canvas(W, H);
  gg.fillStyle = '#000';
  gg.fillRect(0, 0, W, H);

  // Mossy backing so vines read as a solid mass at distance (thin strands alone alias to noise).
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    g.fillStyle = `hsla(${155 + Math.random() * 20}, 40%, ${12 + Math.random() * 6}%, 0.9)`;
    g.beginPath();
    g.ellipse(x, y, 30 + Math.random() * 40, 60 + Math.random() * 90, 0, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 14; i++) {
    let x = (i / 14) * W + Math.random() * 12;
    const hue = 150 + Math.random() * 30;
    g.strokeStyle = `hsl(${hue}, 45%, ${16 + Math.random() * 10}%)`;
    g.lineWidth = 7 + Math.random() * 5;
    g.beginPath();
    g.moveTo(x, 0);
    const wobble = 6 + Math.random() * 10;
    const freq = 0.02 + Math.random() * 0.03;
    const phase = Math.random() * 10;
    for (let y = 0; y <= H; y += 8) {
      const px = x + Math.sin(y * freq + phase) * wobble;
      g.lineTo(px, y);
      if (Math.random() < 0.35) {
        // Leaf
        g.save();
        g.fillStyle = `hsl(${hue + 10}, 50%, ${20 + Math.random() * 12}%)`;
        g.translate(px, y);
        g.rotate((Math.random() - 0.5) * 2.4);
        g.beginPath();
        g.ellipse(9, 0, 11, 5, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      if (Math.random() < 0.035) {
        // Glowing bulb (drawn on both maps so it's opaque and emissive).
        const r = 3 + Math.random() * 3;
        g.fillStyle = '#9dffe0';
        g.beginPath();
        g.arc(px, y, r, 0, Math.PI * 2);
        g.fill();
        gg.fillStyle = '#6dffc8';
        gg.beginPath();
        gg.arc(px, y, r, 0, Math.PI * 2);
        gg.fill();
      }
    }
    g.stroke();
    x += W / 14;
  }
  return { map: toTexture(c), glow: toTexture(gc) };
}
