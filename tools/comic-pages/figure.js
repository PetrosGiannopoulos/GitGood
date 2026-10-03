// The figure: a jointed comic-book mannequin dressed per character.
//
// A pose is a set of joints in a figure space where the feet stand at y=0 and the head sits
// near y=-270 (about eight heads tall). Limbs are tapered capsules, the torso a smooth
// outline through shoulders, chest, waist and hips; every shape is inked, and a cel shadow
// is laid over the lot from the side away from the light. `suit` says what each part is
// made of; `extras` bolt on what makes the character read (claws, cape, shield, horns…).
'use strict';
const { INK, f, mix, dark, light, capsule, smooth, pts, starPts, rng, jag } = require('./lib');

// The bat, in a 200×100 box (the same outline as the Batman theme's art in 00-dc-themes.js).
const BAT_L = [[100, 30], [94, 30], [90, 12], [86, 32], [72, 36], [46, 30], [6, 16], [22, 40], [20, 56], [38, 52], [46, 70], [62, 60], [72, 80], [86, 64], [100, 90]];
const BAT = BAT_L.concat(BAT_L.slice(1, -1).reverse().map(([x, y]) => [200 - x, y]));

// ---------- poses ----------
// Facing right (+x). `lean` is informational; the joints carry the pose.
const POSES = {
  stand: {
    head: [2, -268], neck: [0, -246], shB: [-33, -234], shF: [33, -234], elB: [-44, -178], elF: [46, -178],
    haB: [-46, -122], haF: [50, -122], hipB: [-18, -138], hipF: [18, -138], knB: [-27, -70], knF: [30, -70], ftB: [-36, 0], ftF: [40, 0],
  },
  hips: { // fists on hips: the villain's stance
    head: [0, -268], neck: [0, -246], shB: [-35, -234], shF: [35, -234], elB: [-72, -186], elF: [72, -186],
    haB: [-30, -146], haF: [30, -146], hipB: [-19, -138], hipF: [19, -138], knB: [-34, -70], knF: [34, -70], ftB: [-50, 0], ftF: [50, 0],
  },
  crouch: { // perched on a ledge, facing out
    head: [0, -160], neck: [0, -142], shB: [-31, -130], shF: [31, -130], elB: [-66, -96], elF: [64, -94],
    haB: [-30, -34], haF: [30, -34], hipB: [-17, -56], hipF: [17, -56], knB: [-54, -104], knF: [54, -104], ftB: [-42, 0], ftF: [42, 0],
  },
  punch: {
    head: [26, -258], neck: [18, -236], shB: [-10, -228], shF: [44, -232], elB: [-44, -196], elF: [98, -236],
    haB: [-32, -160], haF: [150, -240], hipB: [-8, -136], hipF: [24, -134], knB: [-50, -72], knF: [68, -86], ftB: [-100, 0], ftF: [96, 0],
  },
  fly: {
    head: [132, -48], neck: [112, -44], shB: [100, -60], shF: [100, -30], elB: [150, -78], elF: [66, -18],
    haB: [196, -86], haF: [36, -14], hipB: [-6, -54], hipF: [-6, -36], knB: [-70, -58], knF: [-70, -36], ftB: [-134, -62], ftF: [-136, -34],
  },
  leap: {
    head: [4, -262], neck: [2, -240], shB: [-32, -228], shF: [34, -230], elB: [-74, -262], elF: [72, -250],
    haB: [-104, -302], haF: [108, -282], hipB: [-16, -134], hipF: [18, -132], knB: [-48, -86], knF: [58, -110], ftB: [-26, -18], ftF: [100, -62],
  },
  cast: { // both hands thrown forward, casting or blasting
    head: [8, -266], neck: [4, -244], shB: [-26, -232], shF: [36, -234], elB: [28, -214], elF: [84, -222],
    haB: [84, -226], haF: [132, -230], hipB: [-16, -136], hipF: [20, -136], knB: [-36, -70], knF: [40, -72], ftB: [-56, 0], ftF: [60, 0],
  },
  swing: { // one arm up on a line, legs tucked
    head: [6, -250], neck: [4, -228], shB: [-28, -218], shF: [34, -222], elB: [-40, -164], elF: [48, -272],
    haB: [-16, -130], haF: [60, -322], hipB: [-12, -126], hipF: [20, -124], knB: [20, -80], knF: [60, -96], ftB: [-14, -30], ftF: [34, -44],
  },
};

// Radii (before bulk): head, neck, upper arm → wrist, thigh → ankle.
const R = { head: 19, neck: 8, sh: 12, el: 9.5, wr: 7.5, hip: 15, kn: 11, an: 8, hand: 9 };

function scalePose(p, bulk, facing) {
  const out = {};
  for (const [k, [x, y]] of Object.entries(p)) {
    // Bulk widens the frame around the spine; height stays.
    const bx = k === 'head' || k === 'neck' ? x : x * (0.85 + bulk * 0.15);
    out[k] = [bx * facing, y];
  }
  return out;
}

// ---------- heads ----------
// Drawn around (0,0) with radius r, facing `dir` (1 right, -1 left, 0 front).
function head(s, r, dir, clip = 'headclip') {
  const H = s.head || {};
  const skin = s.skin || '#e8b48a';
  const mask = H.mask || skin;
  const o = dir * r * 0.22; // face shift toward the facing side
  let b = '';
  const outline = `stroke="${INK}" stroke-width="${f(r * 0.1)}" stroke-linejoin="round"`;
  // Things behind the head.
  if (H.hair === 'long') b += `<path d="${smooth([[-r * 0.95, -r * 0.5], [-r * 0.3, -r * 1.12], [r * 0.7, -r * 0.8], [r * 1.12, r * 0.4], [r * 1.25, r * 1.9], [r * 0.6, r * 2.5], [-r * 0.6, r * 2.5], [-r * 1.25, r * 1.9], [-r * 1.12, r * 0.4]])}" fill="${H.hairColor}" ${outline}/>`;
  if (H.flame) b += flameCrown(r, H.flame);
  if (H.hood) b += `<path d="${smooth([[-r * 1.3, r * 0.9], [-r * 1.45, -r * 0.5], [-r * 0.6, -r * 1.45], [r * 0.7, -r * 1.45], [r * 1.45, -r * 0.4], [r * 1.35, r * 0.95], [0, r * 1.4]])}" fill="${H.hood}" ${outline}/>`;
  if (H.crown === 'hela') b += [-1, -0.5, 0.5, 1].map(k => `<path d="M${f(k * r * 0.5)} ${f(-r * 0.8)} Q${f(k * r * 1.1)} ${f(-r * 2)} ${f(k * r * 1.5)} ${f(-r * 2.9)} Q${f(k * r * 0.9)} ${f(-r * 1.8)} ${f(k * r * 0.1)} ${f(-r * 0.9)} Z" fill="${H.crownColor || '#1a2a20'}" ${outline}/>`).join('');
  // The skull itself.
  if (H.type === 'bowl') {
    b += `<circle r="${f(r * 1.45)}" cy="${f(-r * 0.15)}" fill="${H.glass || '#bfeee0'}" fill-opacity=".45" ${outline}/>`;
    b += `<circle r="${f(r * 1.15)}" cy="${f(-r * 0.1)}" fill="${H.smoke || '#7fe0c0'}" fill-opacity=".75"/>`;
    b += `<path d="M${f(-r * 0.9)} ${f(-r * 0.9)} Q${f(-r * 0.3)} ${f(-r * 1.4)} ${f(r * 0.5)} ${f(-r * 1.2)}" fill="none" stroke="#ffffff" stroke-width="${f(r * 0.14)}" stroke-linecap="round"/>`;
    return b;
  }
  const jaw = H.jaw || 1;
  const shape = [[0, -r * 1.12], [r * 0.92, -r * 0.55], [r * 0.9 * jaw, r * 0.35], [r * 0.45 * jaw + o * 0.3, r * 1.02], [o * 0.4, r * 1.14], [-r * 0.45 * jaw + o * 0.3, r * 1.02], [-r * 0.9 * jaw, r * 0.35], [-r * 0.92, -r * 0.55]];
  const face = smooth(shape);
  b += `<path d="${face}" fill="${H.type === 'cowl' ? skin : mask}" ${outline}/>`;
  // Two faces in one: the far half of the face in another colour (Two-Face's scar,
  // Deathstroke's mask), split down the line of the nose.
  if (H.half) b += `<defs><clipPath id="${clip}hf"><rect x="${f(o * 0.4)}" y="${f(-r * 2)}" width="${f(r * 2)}" height="${f(r * 4)}"/></clipPath></defs>` +
    `<path d="${face}" fill="${H.half}" clip-path="url(#${clip}hf)"/><path d="M${f(o * 0.4)} ${f(-r * 1.1)} V${f(r * 1.12)}" stroke="${INK}" stroke-width="${f(r * 0.06)}"/>`;
  if (H.type === 'cowl') b += `<path d="${smooth([[0, -r * 1.12], [r * 0.92, -r * 0.55], [r * 0.93, r * 0.12], [r * 0.3 + o, r * 0.06], [o, r * 0.15], [-r * 0.3 + o, r * 0.06], [-r * 0.93, r * 0.12], [-r * 0.92, -r * 0.55]])}" fill="${mask}" ${outline}/>`;
  if (H.type === 'skull') {
    b += [-1, 1].map(k => `<ellipse cx="${f(k * r * 0.36 + o)}" cy="${f(-r * 0.08)}" rx="${f(r * 0.28)}" ry="${f(r * 0.33)}" fill="${H.socket || INK}"/>`).join('');
    b += `<path d="M${f(o - r * 0.12)} ${f(r * 0.38)} L${f(o)} ${f(r * 0.18)} L${f(o + r * 0.12)} ${f(r * 0.38)} Z" fill="${INK}"/>`;
    b += `<path d="M${f(-r * 0.45 + o)} ${f(r * 0.72)} H${f(r * 0.45 + o)} M${f(-r * 0.3 + o)} ${f(r * 0.6)} V${f(r * 0.86)} M${f(o)} ${f(r * 0.6)} V${f(r * 0.9)} M${f(r * 0.3 + o)} ${f(r * 0.6)} V${f(r * 0.86)}" stroke="${INK}" stroke-width="${f(r * 0.07)}"/>`;
  }
  if (H.hair && H.hair !== 'long' && H.hair !== 'none') {
    const hc = H.hairColor;
    if (H.hair === 'short') b += `<path d="${smooth([[-r * 0.95, -r * 0.2], [-r * 0.85, -r * 0.95], [0, -r * 1.3], [r * 0.85, -r * 0.95], [r * 0.95, -r * 0.2], [r * 0.5, -r * 0.7], [-r * 0.5, -r * 0.7]])}" fill="${hc}" ${outline}/>`;
    if (H.hair === 'spiky') b += `<polygon points="${pts([[-r * 1, -r * 0.1], [-r * 1.2, -r * 1.0], [-r * 0.5, -r * 1.0], [-r * 0.3, -r * 1.6], [r * 0.2, -r * 1.05], [r * 0.8, -r * 1.5], [r * 0.8, -r * 0.8], [r * 1.3, -r * 0.7], [r * 0.95, -r * 0.1], [r * 0.5, -r * 0.65], [-r * 0.5, -r * 0.65]])}" fill="${hc}" ${outline}/>`;
    if (H.hair === 'bald-beard') b += `<path d="${smooth([[-r * 0.9, r * 0.2], [-r * 0.5, r * 1.2], [o, r * 1.45], [r * 0.5, r * 1.2], [r * 0.9, r * 0.2], [r * 0.4, r * 0.5], [-r * 0.4, r * 0.5]])}" fill="${hc}" ${outline}/>`;
  }
  if (H.hair === 'long') {
    b += `<path d="${smooth([[-r * 0.98, -r * 0.1], [-r * 0.9, -r * 0.85], [0, -r * 1.24], [r * 0.9, -r * 0.88], [r * 0.99, -r * 0.2], [r * 0.7, -r * 0.62], [r * 0.1, -r * 0.72], [-r * 0.35, -r * 0.5], [-r * 0.78, -r * 0.45]])}" fill="${H.hairColor}" ${outline}/>`;
    b += `<path d="M${f(-r * 0.2)} ${f(-r * 1.15)} Q${f(-r * 0.5)} ${f(-r * 0.8)} ${f(-r * 0.7)} ${f(-r * 0.5)} M${f(r * 0.3)} ${f(-r * 1.1)} Q${f(r * 0.7)} ${f(-r * 0.8)} ${f(r * 0.85)} ${f(-r * 0.4)} M${f(r * 1.0)} ${f(r * 0.6)} Q${f(r * 1.1)} ${f(r * 1.4)} ${f(r * 0.9)} ${f(r * 2.1)} M${f(-r * 1.0)} ${f(r * 0.6)} Q${f(-r * 1.1)} ${f(r * 1.4)} ${f(-r * 0.9)} ${f(r * 2.1)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.04)}" stroke-opacity=".6"/>`;
  }
  // Eyes.
  const eyes = H.eyes || 'plain';
  const ex = (k) => k * r * 0.38 + o;
  if (H.patches) b += [-1, 1].map(k => `<ellipse cx="${f(ex(k))}" cy="${f(-r * 0.1)}" rx="${f(r * 0.4)}" ry="${f(r * 0.46)}" transform="rotate(${k * -20} ${f(ex(k))} ${f(-r * 0.1)})" fill="${H.patches}"/>`).join('');
  if (eyes === 'lens' || eyes === 'lens-big') {
    const big = eyes === 'lens-big' ? 1.35 : 1;
    b += [-1, 1].map(k => {
      const cx = ex(k), cy = -r * 0.12;
      const d = `M${f(cx - k * r * 0.05 * big)} ${f(cy + r * 0.28 * big)} Q${f(cx - k * r * 0.42 * big)} ${f(cy - r * 0.05)} ${f(cx - k * r * 0.1 * big)} ${f(cy - r * 0.38 * big)} Q${f(cx + k * r * 0.32 * big)} ${f(cy - r * 0.28 * big)} ${f(cx + k * r * 0.2 * big)} ${f(cy + r * 0.12)} Z`;
      return `<path d="${d}" fill="${H.lens || '#f6f8ff'}" stroke="${INK}" stroke-width="${f(r * 0.13)}" stroke-linejoin="round"/>`;
    }).join('');
  } else if (eyes === 'slit' || eyes === 'glow') {
    const c = H.eyeColor || '#bff4ff';
    b += [-1, 1].map(k => `<path d="M${f(ex(k) - r * 0.26)} ${f(-r * 0.2)} L${f(ex(k) + r * 0.26)} ${f(-r * 0.12)} L${f(ex(k) + r * 0.22)} ${f(r * 0.0)} L${f(ex(k) - r * 0.24)} ${f(-r * 0.06)} Z" fill="${c}" stroke="${INK}" stroke-width="${f(r * 0.06)}"/>`).join('');
  } else if (eyes === 'visor') {
    b += `<path d="M${f(-r * 0.95)} ${f(-r * 0.32)} L${f(r * 0.95)} ${f(-r * 0.32)} L${f(r * 0.9)} ${f(r * 0.05)} L${f(-r * 0.9)} ${f(r * 0.05)} Z" fill="${H.eyeColor || '#ff3a44'}" stroke="${INK}" stroke-width="${f(r * 0.1)}"/>`;
    b += `<path d="M${f(-r * 0.7)} ${f(-r * 0.2)} H${f(r * 0.4)}" stroke="#ffffff" stroke-opacity=".8" stroke-width="${f(r * 0.06)}"/>`;
  } else if (eyes === 'plain' || eyes === 'white') {
    const iris = eyes === 'white' ? '#ffffff' : INK;
    b += [-1, 1].map(k => `<path d="M${f(ex(k) - r * 0.2)} ${f(-r * 0.08)} Q${f(ex(k))} ${f(-r * 0.2)} ${f(ex(k) + r * 0.2)} ${f(-r * 0.08)} Q${f(ex(k))} ${f(r * 0.02)} ${f(ex(k) - r * 0.2)} ${f(-r * 0.08)} Z" fill="#ffffff" stroke="${INK}" stroke-width="${f(r * 0.05)}"/><circle cx="${f(ex(k) + dir * r * 0.05)}" cy="${f(-r * 0.08)}" r="${f(r * 0.065)}" fill="${iris}"/>` +
      // Brows: heavy, angled down toward the nose — every face on the page is determined.
      `<path d="M${f(ex(k) - k * r * 0.26)} ${f(-r * 0.36)} L${f(ex(k) + k * r * 0.22)} ${f(-r * 0.24)}" stroke="${H.brow || INK}" stroke-width="${f(r * 0.1)}" stroke-linecap="round"/>`).join('');
  }
  // The lower face, wherever it shows: nose, mouth, the line of the cheek.
  if ((H.type !== 'skull' && (!H.mask || H.mask === skin || H.type === 'cowl')) || H.mouth) {
    b += `<path d="M${f(o + dir * r * 0.06)} ${f(r * 0.02)} L${f(o + dir * r * 0.2 + (dir ? 0 : r * 0.08))} ${f(r * 0.36)} L${f(o - dir * r * 0.02)} ${f(r * 0.4)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.055)}" stroke-linejoin="round"/>`;
    b += `<path d="M${f(o - r * 0.26)} ${f(r * 0.62)} Q${f(o)} ${f(r * 0.58)} ${f(o + r * 0.26)} ${f(r * 0.6)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.06)}" stroke-linecap="round"/>`;
    b += `<path d="M${f(-dir * r * 0.78 || -r * 0.78)} ${f(r * 0.1)} Q${f(-dir * r * 0.7 || -r * 0.7)} ${f(r * 0.6)} ${f(o - dir * r * 0.3)} ${f(r * 0.95)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.04)}" stroke-opacity=".45"/>`;
  }
  // Mask markings.
  if (H.web) b += webLines(r, H.webColor || INK, clip);
  if (H.faceplate) b += `<path d="${smooth([[0, -r * 0.62], [r * 0.62, -r * 0.35], [r * 0.6, r * 0.5], [r * 0.3, r * 0.95], [0, r * 1.02], [-r * 0.3, r * 0.95], [-r * 0.6, r * 0.5], [-r * 0.62, -r * 0.35]])}" fill="${H.faceplate}" stroke="${INK}" stroke-width="${f(r * 0.08)}" transform="translate(${f(o * 0.6)} 0)"/>` +
    [-1, 1].map(k => `<path d="M${f(ex(k) * 0.9 - r * 0.22)} ${f(-r * 0.16)} L${f(ex(k) * 0.9 + r * 0.22)} ${f(-r * 0.1)} L${f(ex(k) * 0.9 + r * 0.18)} ${f(r * 0.0)} L${f(ex(k) * 0.9 - r * 0.2)} ${f(-r * 0.05)} Z" fill="${H.eyeColor || '#dff8ff'}" stroke="${INK}" stroke-width="${f(r * 0.05)}"/>`).join('');
  if (H.stripe) b += `<path d="M${f(-r * 0.12)} ${f(-r * 1.1)} L${f(r * 0.12)} ${f(-r * 1.1)} L${f(r * 0.1)} ${f(r * 1.05)} L${f(-r * 0.1)} ${f(r * 1.05)} Z" fill="${H.stripe}" opacity=".9"/>`;
  if (H.star) b += `<polygon points="${starPts(o, -r * 0.2, r * 0.95, r * 0.35, 5)}" fill="${H.star}" stroke="${INK}" stroke-width="${f(r * 0.07)}"/>` + [-1, 1].map(k => `<ellipse cx="${f(ex(k))}" cy="${f(-r * 0.1)}" rx="${f(r * 0.13)}" ry="${f(r * 0.09)}" fill="#ffffff"/>`).join('');
  if (H.letter) b += `<text x="${f(o)}" y="${f(-r * 0.55)}" font-family="Impact, sans-serif" font-size="${f(r * 0.6)}" fill="${H.letterColor || '#ffffff'}" text-anchor="middle" stroke="${INK}" stroke-width="${f(r * 0.04)}">${H.letter}</text>`;
  if (H.wings) b += [-1, 1].map(k => `<path d="M${f(k * r * 0.9)} ${f(-r * 0.3)} L${f(k * r * 1.5)} ${f(-r * 0.9)} L${f(k * r * 1.2)} ${f(-r * 0.2)} L${f(k * r * 1.55)} ${f(-r * 0.4)} L${f(k * r * 0.95)} ${f(r * 0.1)} Z" fill="${H.wings}" ${outline}/>`).join('');
  if (H.horns) b += [-1, 1].map(k => `<path d="M${f(k * r * 0.35)} ${f(-r * 0.95)} C${f(k * r * 0.6)} ${f(-r * 1.8)} ${f(k * r * 1.4)} ${f(-r * 2.4)} ${f(k * r * 1.9)} ${f(-r * 3.3)} C${f(k * r * 1.1)} ${f(-r * 2.6)} ${f(k * r * 0.4)} ${f(-r * 2)} ${f(k * r * 0.02)} ${f(-r * 1.05)} Z" fill="${H.horns}" ${outline}/>`).join('');
  if (H.ears) b += [-1, 1].map(k => `<path d="M${f(k * r * 0.4)} ${f(-r * 1.0)} L${f(k * r * 0.75)} ${f(-r * 1.55)} L${f(k * r * 0.9)} ${f(-r * 0.7)} Z" fill="${mask}" ${outline}/>`).join('');
  if (H.antenna) b += [-1, 1].map(k => `<path d="M${f(k * r * 0.5)} ${f(-r * 0.85)} Q${f(k * r * 1.1)} ${f(-r * 1.8)} ${f(k * r * 0.7)} ${f(-r * 2.1)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.1)}"/>`).join('') +
    `<circle cx="${f(-r * 0.95)}" cy="${f(-r * 0.05)}" r="${f(r * 0.3)}" fill="${H.antenna}" ${outline}/><circle cx="${f(r * 0.95)}" cy="${f(-r * 0.05)}" r="${f(r * 0.3)}" fill="${H.antenna}" ${outline}/>`;
  if (H.fins) b += [-1, 1].map(k => `<path d="M${f(k * r * 0.9)} ${f(-r * 0.1)} L${f(k * r * 1.5)} ${f(-r * 0.65)} L${f(k * r * 1.0)} ${f(r * 0.2)} Z" fill="${skin}" ${outline}/>`).join('');
  if (H.tiara) b += `<path d="M${f(-r * 0.9)} ${f(-r * 0.55)} Q0 ${f(-r * 0.9)} ${f(r * 0.9)} ${f(-r * 0.55)} L${f(r * 0.5)} ${f(-r * 1.25)} L${f(r * 0.3)} ${f(-r * 0.8)} L0 ${f(-r * 1.6)} L${f(-r * 0.3)} ${f(-r * 0.8)} L${f(-r * 0.5)} ${f(-r * 1.25)} Z" fill="${H.tiara}" ${outline}/>`;
  if (H.bandana) b += `<path d="M${f(-r * 0.95)} ${f(-r * 0.36)} Q0 ${f(-r * 0.5)} ${f(r * 0.95)} ${f(-r * 0.36)} L${f(r * 0.95)} ${f(r * 0.02)} Q0 ${f(-r * 0.1)} ${f(-r * 0.95)} ${f(r * 0.02)} Z" fill="${H.bandana}" stroke="${INK}" stroke-width="${f(r * 0.07)}"/>` +
    [-1, 1].map(k => `<ellipse cx="${f(ex(k))}" cy="${f(-r * 0.16)}" rx="${f(r * 0.14)}" ry="${f(r * 0.08)}" fill="#ffffff" stroke="${INK}" stroke-width="${f(r * 0.04)}"/>`).join('');
  if (H.fangs) b += `<path d="M${f(-r * 0.7 + o)} ${f(r * 0.35)} Q${f(o)} ${f(r * 1.25)} ${f(r * 0.7 + o)} ${f(r * 0.35)} Q${f(o)} ${f(r * 0.7)} ${f(-r * 0.7 + o)} ${f(r * 0.35)} Z" fill="#ffffff" stroke="${INK}" stroke-width="${f(r * 0.08)}"/>` +
    Array.from({ length: 9 }, (_, i) => { const t = (i + 0.5) / 9, x = -r * 0.62 + t * r * 1.24 + o; return `<path d="M${f(x)} ${f(r * 0.5)} v${f(r * 0.2)}" stroke="${INK}" stroke-width="${f(r * 0.04)}"/>`; }).join('');
  if (H.goggles) b += [-1, 1].map(k => `<circle cx="${f(ex(k))}" cy="${f(-r * 0.12)}" r="${f(r * 0.28)}" fill="${H.goggles}" stroke="${INK}" stroke-width="${f(r * 0.1)}"/>`).join('');
  if (H.helm) b += `<path d="${smooth([[-r * 1.02, r * 0.1], [-r * 1.05, -r * 0.8], [0, -r * 1.3], [r * 1.05, -r * 0.8], [r * 1.02, r * 0.1], [r * 0.7, -r * 0.45], [-r * 0.7, -r * 0.45]])}" fill="${H.helm}" ${outline}/>`;
  if (H.bigHelm) b += `<path d="M${f(-r * 1.1)} ${f(r * 0.6)} L${f(-r * 1.3)} ${f(-r * 0.8)} L${f(-r * 2.1)} ${f(-r * 2.4)} L${f(-r * 0.6)} ${f(-r * 1.3)} L0 ${f(-r * 1.6)} L${f(r * 0.6)} ${f(-r * 1.3)} L${f(r * 2.1)} ${f(-r * 2.4)} L${f(r * 1.3)} ${f(-r * 0.8)} L${f(r * 1.1)} ${f(r * 0.6)} L${f(r * 0.7)} ${f(r * 0.1)} L${f(-r * 0.7)} ${f(r * 0.1)} Z" fill="${H.bigHelm}" ${outline}/>` +
    `<path d="M${f(-r * 0.25)} ${f(-r * 1.4)} L0 ${f(-r * 0.5)} L${f(r * 0.25)} ${f(-r * 1.4)}" fill="${H.bigHelmTrim || '#3f6ad2'}" stroke="${INK}" stroke-width="${f(r * 0.06)}"/>`;
  if (H.chin) b += `<path d="M${f(-r * 0.4 + o)} ${f(r * 0.55)} Q${f(o)} ${f(r * 0.75)} ${f(r * 0.4 + o)} ${f(r * 0.55)} M${f(-r * 0.35 + o)} ${f(r * 0.8)} Q${f(o)} ${f(r * 1.0)} ${f(r * 0.35 + o)} ${f(r * 0.8)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.06)}"/>`;
  // Coluan intelligence: three discs set in the brow.
  if (H.dots) b += [[-0.28, -0.62], [0, -0.8], [0.28, -0.62]].map(([x, y]) => `<circle cx="${f(o + x * r)}" cy="${f(y * r)}" r="${f(r * 0.1)}" fill="${H.dots}" stroke="${INK}" stroke-width="${f(r * 0.04)}"/>`).join('');
  // Hats sit on top of everything: a stage top hat, or a bowler.
  if (H.hat === 'top') b += `<rect x="${f(-r * 0.68)}" y="${f(-r * 2.35)}" width="${f(r * 1.36)}" height="${f(r * 1.5)}" fill="${H.hatColor || INK}" ${outline}/>` +
    `<rect x="${f(-r * 0.68)}" y="${f(-r * 1.2)}" width="${f(r * 1.36)}" height="${f(r * 0.28)}" fill="${H.hatBand || '#c8302a'}" ${outline}/>` +
    `<ellipse cy="${f(-r * 0.86)}" rx="${f(r * 1.2)}" ry="${f(r * 0.22)}" fill="${H.hatColor || INK}" ${outline}/>`;
  if (H.hat === 'bowler') b += `<path d="M${f(-r * 0.78)} ${f(-r * 0.8)} C${f(-r * 0.8)} ${f(-r * 1.9)} ${f(r * 0.8)} ${f(-r * 1.9)} ${f(r * 0.78)} ${f(-r * 0.8)} Z" fill="${H.hatColor || INK}" ${outline}/>` +
    `<ellipse cy="${f(-r * 0.8)}" rx="${f(r * 1.12)}" ry="${f(r * 0.2)}" fill="${H.hatColor || INK}" ${outline}/>` +
    (H.hatBand ? `<path d="M${f(-r * 0.76)} ${f(-r * 0.98)} H${f(r * 0.76)}" stroke="${H.hatBand}" stroke-width="${f(r * 0.16)}"/>` : '');
  return b;
}

function webLines(r, c, clip) {
  let b = '';
  const cx = 0, cy = -r * 0.05;
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; b += `M${f(cx)} ${f(cy)} L${f(cx + Math.cos(a) * r * 1.3)} ${f(cy + Math.sin(a) * r * 1.3)} `; }
  for (let k = 1; k <= 3; k++) {
    const rr = r * 0.34 * k;
    for (let i = 0; i < 12; i++) {
      const a0 = i / 12 * Math.PI * 2, a1 = (i + 1) / 12 * Math.PI * 2, am = (a0 + a1) / 2;
      b += `M${f(cx + Math.cos(a0) * rr)} ${f(cy + Math.sin(a0) * rr)} Q${f(cx + Math.cos(am) * rr * 0.86)} ${f(cy + Math.sin(am) * rr * 0.86)} ${f(cx + Math.cos(a1) * rr)} ${f(cy + Math.sin(a1) * rr)} `;
    }
  }
  return `<path d="${b}" fill="none" stroke="${c}" stroke-width="${f(r * 0.035)}" stroke-opacity=".85" clip-path="url(#${clip})"/>`;
}

function flameCrown(r, c) {
  const rr = rng(7);
  let tongues = '';
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI + (i / 8) * Math.PI, h = r * (1.4 + rr() * 1.6);
    const bx = Math.cos(a) * r * 0.95, by = Math.sin(a) * r * 0.9;
    tongues += `<path d="M${f(bx - r * 0.35)} ${f(by + r * 0.3)} Q${f(bx + Math.cos(a) * h * 0.4)} ${f(by - h * 0.5)} ${f(bx + Math.cos(a) * h * 0.2 + (rr() - 0.5) * r)} ${f(by - h)} Q${f(bx + r * 0.3)} ${f(by - h * 0.4)} ${f(bx + r * 0.4)} ${f(by + r * 0.3)} Z"/>`;
  }
  return `<g fill="${c[0]}" stroke="${INK}" stroke-width="${f(r * 0.08)}">${tongues}</g><g fill="${c[1]}" transform="scale(.7) translate(0 ${f(r * 0.3)})">${tongues}</g>`;
}

// ---------- the figure ----------
// Returns SVG for the figure standing at (0,0), `size` = figure height in px.
let uid = 0;
function figure(spec, poseName, { size = 300, facing = 1, light: lightDir = -1 } = {}) {
  const s = spec.suit;
  const bulk = s.bulk || 1;
  const P = scalePose(POSES[poseName] || POSES.stand, bulk, facing);
  const k = size / 290;
  const id = 'fg' + (++uid);
  const W = (v) => v * k;
  const sc = (v) => v * (0.8 + bulk * 0.2);
  const inkW = 3.2 / k; // drawn inside a scaled group, so the line weight is pre-divided
  const ink = `stroke="${INK}" stroke-width="${f(inkW)}" stroke-linejoin="round"`;

  const col = {
    torso: s.torso, arms: s.arms || s.torso, legs: s.legs || s.torso, gloves: s.gloves || s.arms || s.torso,
    boots: s.boots || s.legs || s.torso, belt: s.belt, neck: s.neck || (s.head && s.head.mask) || s.skin || s.torso,
  };
  const limb = (a, b, r1, r2, fill) => `<path d="${capsule(a[0], a[1], sc(r1), b[0], b[1], sc(r2))}" fill="${fill}" ${ink}/>`;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const arm = (sh, el, ha, side) => {
    let o = limb(sh, el, R.sh, R.el, col.arms) + limb(el, ha, R.el, R.wr, col.arms);
    const gl = lerp(el, ha, s.longGloves ? 0.15 : 0.55);
    if (col.gloves !== col.arms) o += limb(gl, ha, R.el * 0.95, R.wr * 1.02, col.gloves);
    if (s.armStripe) o += `<path d="M${f(sh[0])} ${f(sh[1])} L${f(el[0])} ${f(el[1])} L${f(ha[0])} ${f(ha[1])}" fill="none" stroke="${s.armStripe}" stroke-width="${f(sc(5))}" stroke-linecap="round"/>`;
    o += `<circle cx="${f(ha[0])}" cy="${f(ha[1])}" r="${f(sc(R.hand))}" fill="${col.gloves}" ${ink}/>`;
    if (s.handGlow) o += `<circle cx="${f(ha[0])}" cy="${f(ha[1])}" r="${f(sc(R.hand) * 2.2)}" fill="${s.handGlow}" opacity=".55"/><circle cx="${f(ha[0])}" cy="${f(ha[1])}" r="${f(sc(R.hand) * 1.3)}" fill="#ffffff" opacity=".8"/>`;
    return o;
  };
  const leg = (hip, kn, ft) => {
    let o = limb(hip, kn, R.hip, R.kn, col.legs) + limb(kn, ft, R.kn, R.an, col.legs);
    const bt = lerp(kn, ft, s.tallBoots ? 0.05 : 0.45);
    if (col.boots !== col.legs) o += limb(bt, ft, R.kn * 0.98, R.an * 1.05, col.boots);
    if (s.legStripe) o += `<path d="M${f(hip[0])} ${f(hip[1])} L${f(kn[0])} ${f(kn[1])} L${f(ft[0])} ${f(ft[1])}" fill="none" stroke="${s.legStripe}" stroke-width="${f(sc(5))}" stroke-linecap="round"/>`;
    // Foot: a short wedge in the facing direction.
    const dir = facing, fx = ft[0], fy = ft[1];
    o += `<path d="M${f(fx - dir * sc(8))} ${f(fy - sc(10))} Q${f(fx + dir * sc(18))} ${f(fy - sc(8))} ${f(fx + dir * sc(20))} ${f(fy + sc(2))} L${f(fx - dir * sc(8))} ${f(fy + sc(2))} Z" fill="${col.boots}" ${ink}/>`;
    return o;
  };

  // Torso outline through shoulders, chest, waist and hips.
  const shB = P.shB, shF = P.shF, hipB = P.hipB, hipF = P.hipF;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const up = mid(shB, shF), dn = mid(hipB, hipF);
  const axis = [dn[0] - up[0], dn[1] - up[1]], alen = Math.hypot(...axis), nx = -axis[1] / alen, ny = axis[0] / alen;
  const halfSh = Math.hypot(shF[0] - shB[0], shF[1] - shB[1]) / 2 + sc(10);
  const halfHip = Math.hypot(hipF[0] - hipB[0], hipF[1] - hipB[1]) / 2 + sc(10);
  const along = (t, w) => [up[0] + axis[0] * t + nx * w, up[1] + axis[1] * t + ny * w];
  const waist = (s.waist || 0.72) * halfHip * 1.05;
  const torsoPts = [
    along(-0.04, halfSh), along(0.28, halfSh * 0.95), along(0.66, waist), along(1.0, halfHip),
    along(1.06, 0), along(1.0, -halfHip), along(0.66, -waist), along(0.28, -halfSh * 0.95), along(-0.04, -halfSh), along(-0.1, 0),
  ];
  const torsoD = smooth(torsoPts);
  let torso = `<path d="${torsoD}" fill="${col.torso}" ${ink}/>`;
  // Two-tone suits: the lower torso (or the sides) in a second colour.
  if (s.lower) torso += `<path d="${smooth([along(0.5, halfSh * 0.95), along(0.66, waist), along(1.0, halfHip), along(1.06, 0), along(1.0, -halfHip), along(0.66, -waist), along(0.5, -halfSh * 0.95), along(0.56, 0)])}" fill="${s.lower}" ${ink}/>`;
  if (s.sides) torso += [1, -1].map(k2 => `<path d="${smooth([along(0.05, k2 * halfSh * 0.98), along(0.3, k2 * halfSh * 0.95), along(0.66, k2 * waist), along(0.98, k2 * halfHip), along(0.95, k2 * halfHip * 0.62), along(0.6, k2 * waist * 0.55), along(0.3, k2 * halfSh * 0.62)], false)} Z" fill="${s.sides}" ${ink}/>`).join('');
  if (s.vest) torso += `<path d="${smooth([along(0.02, halfSh * 0.55), along(0.5, waist * 0.3), along(1.02, halfHip * 0.5), along(1.02, -halfHip * 0.5), along(0.5, -waist * 0.3), along(0.02, -halfSh * 0.55)])}" fill="${s.vest}" ${ink}/>`;
  if (s.web) torso += `<g clip-path="url(#${id}t)">${bodyWeb(up, axis, nx, ny, halfSh, s.webColor || INK, inkW)}</g>`;
  // Straps crossed over the chest, shoulder to opposite hip (the Manhunter's harness).
  if (s.xStraps) torso += `<g clip-path="url(#${id}t)">` + [1, -1].map(k2 => { const a = along(0.0, k2 * halfSh * 0.9), b2 = along(0.95, -k2 * halfHip * 0.9); return `<path d="M${f(a[0])} ${f(a[1])} L${f(b2[0])} ${f(b2[1])}" stroke="${INK}" stroke-width="${f(sc(12) + inkW)}"/><path d="M${f(a[0])} ${f(a[1])} L${f(b2[0])} ${f(b2[1])}" stroke="${s.xStraps}" stroke-width="${f(sc(12))}"/>`; }).join('') + '</g>';
  // A big cat's coat: rosettes scattered over the torso.
  if (s.spots) { const rr = rng(5); let sp = ''; for (let i = 0; i < 22; i++) { const p = along(rr() * 1.05 - 0.02, (rr() * 2 - 1) * halfSh); sp += `<ellipse cx="${f(p[0])}" cy="${f(p[1])}" rx="${f(sc(3 + rr() * 3))}" ry="${f(sc(2.4 + rr() * 2))}" fill="${s.spots}"/>`; } torso += `<g clip-path="url(#${id}t)">${sp}</g>`; }
  if (s.abs) torso += `<path d="M${f(along(0.42, 0)[0])} ${f(along(0.42, 0)[1])} L${f(along(0.95, 0)[0])} ${f(along(0.95, 0)[1])} M${f(along(0.35, halfSh * 0.5)[0])} ${f(along(0.35, halfSh * 0.5)[1])} Q${f(along(0.42, 0)[0])} ${f(along(0.42, 0)[1] + 6)} ${f(along(0.35, -halfSh * 0.5)[0])} ${f(along(0.35, -halfSh * 0.5)[1])} M${f(along(0.6, waist * 0.6)[0])} ${f(along(0.6, waist * 0.6)[1])} L${f(along(0.6, -waist * 0.6)[0])} ${f(along(0.6, -waist * 0.6)[1])} M${f(along(0.76, waist * 0.55)[0])} ${f(along(0.76, waist * 0.55)[1])} L${f(along(0.76, -waist * 0.55)[0])} ${f(along(0.76, -waist * 0.55)[1])}" fill="none" stroke="${INK}" stroke-width="${f(inkW * 0.7)}" stroke-opacity=".6"/>`;
  if (s.belt) { const a = along(0.92, halfHip * 1.02), b2 = along(0.92, -halfHip * 1.02), c = along(1.0, -halfHip * 1.05), d = along(1.0, halfHip * 1.05); torso += `<polygon points="${pts([a, b2, c, d])}" fill="${s.belt}" ${ink}/>`; }
  if (s.emblem) torso += emblem(s.emblem, along(0.24, 0), sc(15), s.emblemColor || '#ffffff', inkW, Math.atan2(axis[1], axis[0]) - Math.PI / 2);

  const headR = sc(R.head) * (s.headScale || 1);
  const dir = poseName === 'crouch' ? 0 : facing;
  const headSvg = `<g transform="translate(${f(P.head[0])} ${f(P.head[1])})"><defs><clipPath id="${id}h"><circle r="${f(headR * 1.05)}" cy="${f(-headR * 0.05)}"/></clipPath></defs>${head(s, headR, dir, id + 'h')}</g>`;
  const neck = limb(P.neck, P.head, R.neck * 1.3, R.neck, col.neck);

  // Capes hang from the shoulders, behind everything, and flow away from the facing side.
  let back = '';
  if (s.cape) {
    const flow = poseName === 'fly' ? [-260 * facing, -30] : [-90 * facing, 0];
    const bot = poseName === 'fly' ? P.ftB : [(P.ftB[0] + P.ftF[0]) / 2, Math.max(P.ftB[1], P.ftF[1]) - 20];
    const c = [
      [shB[0] - facing * 6, shB[1] - 6], [shF[0] + facing * 6, shF[1] - 6],
      [shF[0] + facing * 16 + flow[0] * 0.2, (shF[1] + bot[1]) / 2],
      [bot[0] + flow[0] * 0.55 + 30 * facing, bot[1] + flow[1] + 10],
      [bot[0] + flow[0], bot[1] + flow[1] - 30], [bot[0] + flow[0] * 0.8, bot[1] + flow[1] - 70],
      [shB[0] + flow[0] * 0.35, (shB[1] + bot[1]) / 2],
    ];
    back += `<path d="${smooth(c)}" fill="${s.cape}" ${ink}/><path d="${smooth([c[2], c[3], c[4]], false)}" fill="none" stroke="${dark(s.cape, 0.4)}" stroke-width="${f(inkW * 1.4)}" stroke-opacity=".6"/>`;
    back += `<path d="M${f(c[6][0] + 10)} ${f(c[6][1])} Q${f(c[4][0] + 20)} ${f(c[4][1] - 40)} ${f(c[4][0])} ${f(c[4][1])}" fill="none" stroke="${INK}" stroke-width="${f(inkW * 0.7)}" stroke-opacity=".5"/>`;
  }
  if (s.wings) back += wings(s.wings, mid(shB, shF), facing, inkW, s.wingColor || '#c8d0dc');
  if (s.tentacles) back += tentacles(mid(shB, shF), dn, facing, inkW, s.tentacles);
  if (s.tail) back += `<path d="${capsule(dn[0], dn[1], sc(9), dn[0] - facing * 70, dn[1] + 10, sc(16))}" fill="${s.tail}" ${ink}/><path d="${capsule(dn[0] - facing * 50, dn[1] + 6, sc(12), dn[0] - facing * 70, dn[1] + 10, sc(16))}" fill="${dark(s.tail, 0.5)}" ${ink}/>`;
  if (s.swordsBack) back += [-1, 1].map(k2 => `<g transform="translate(${f(up[0])} ${f(up[1] + 30)}) rotate(${k2 * 32})"><rect x="-3" y="-120" width="6" height="110" fill="#dfe6ee" ${ink}/><rect x="-5" y="-150" width="10" height="34" fill="${INK}"/><rect x="-12" y="-120" width="24" height="5" fill="#9aa4b0" ${ink}/></g>`).join('');

  const front = { sh: shF, el: P.elF, ha: P.haF, hip: hipF, kn: P.knF, ft: P.ftF };
  const behind = { sh: shB, el: P.elB, ha: P.haB, hip: hipB, kn: P.knB, ft: P.ftB };
  let body = back;
  body += arm(behind.sh, behind.el, behind.ha, 'b') + leg(behind.hip, behind.kn, behind.ft);
  body += torso;
  body += leg(front.hip, front.kn, front.ft);
  body += neck + headSvg;
  body += arm(front.sh, front.el, front.ha, 'f');
  if (s.shoulderPads) body += [shB, shF].map(p => `<circle cx="${f(p[0])}" cy="${f(p[1] + 3)}" r="${f(sc(15))}" fill="${s.shoulderPads}" ${ink}/>`).join('');
  body += handProps(s, front.ha, behind.ha, front.el, facing, inkW, sc);
  if (s.board) {
    const fy = Math.max(P.ftB[1], P.ftF[1]) + sc(4), fx = (P.ftB[0] + P.ftF[0]) / 2;
    body += `<path d="M${f(fx - 150)} ${f(fy)} Q${f(fx)} ${f(fy - 22)} ${f(fx + 170)} ${f(fy - 4)} Q${f(fx + 10)} ${f(fy + 22)} ${f(fx - 150)} ${f(fy)} Z" fill="${s.board}" ${ink}/><path d="M${f(fx - 120)} ${f(fy - 2)} Q${f(fx)} ${f(fy - 14)} ${f(fx + 140)} ${f(fy - 4)}" fill="none" stroke="#ffffff" stroke-width="${f(inkW)}" stroke-opacity=".8"/>`;
  }


  // Silhouette for the shadow pass and the thick outer contour.
  const lightX = lightDir * facing;
  const defs = `<clipPath id="${id}t"><path d="${torsoD}"/></clipPath>` +
    `<linearGradient id="${id}g" x1="${lightX < 0 ? 0 : 1}" y1="0" x2="${lightX < 0 ? 1 : 0}" y2=".5"><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset=".56" stop-color="#fff" stop-opacity="1"/></linearGradient>` +
    `<mask id="${id}m" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#${id}g)"/></mask>` +
    `<filter id="${id}s" x="-5%" y="-5%" width="110%" height="110%"><feColorMatrix type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.05  0 0 0 0 0.12  0 0 0 .4 0"/></filter>` +
    (s.aura ? [0, 1].map(i => `<filter id="${id}a${i}" x="-40%" y="-40%" width="180%" height="180%"><feMorphology in="SourceAlpha" operator="dilate" radius="${i ? 5 : 13}" result="d"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency="${i ? '.07 .05' : '.045 .03'}" numOctaves="2" seed="${4 + i}" result="n"/><feDisplacementMap in="d" in2="n" scale="${i ? 16 : 34}" xChannelSelector="R" yChannelSelector="G" result="w"/>` +
      `<feFlood flood-color="${s.aura[i]}"/><feComposite in2="w" operator="in"/></filter>`).join('') : '') +
    `<filter id="${id}o" x="-10%" y="-10%" width="120%" height="120%"><feMorphology in="SourceAlpha" operator="dilate" radius="${f(2.2 / k)}" result="d"/><feFlood flood-color="${INK}"/><feComposite in2="d" operator="in" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  return `<g transform="scale(${f(k * 1000) / 1000})"><defs>${defs}<g id="${id}">${body}</g></defs>` +
    (s.aura ? `<use href="#${id}" filter="url(#${id}a0)"/><use href="#${id}" filter="url(#${id}a1)"/>` : '') +
    `<g filter="url(#${id}o)"><use href="#${id}"/></g><g mask="url(#${id}m)"><use href="#${id}" filter="url(#${id}s)"/></g></g>`;
}

function bodyWeb(up, axis, nx, ny, half, c, w) {
  let d = '';
  const base = [up[0] + axis[0] * 0.25, up[1] + axis[1] * 0.25];
  for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; d += `M${f(base[0])} ${f(base[1])} L${f(base[0] + Math.cos(a) * 160)} ${f(base[1] + Math.sin(a) * 160)} `; }
  for (let k = 1; k <= 6; k++) d += `M${f(base[0] + 18 * k)} ${f(base[1])} A${18 * k} ${18 * k} 0 1 1 ${f(base[0] + 18 * k - 0.1)} ${f(base[1] - 0.5)} `;
  return `<path d="${d}" fill="none" stroke="${c}" stroke-width="${f(w * 0.45)}" stroke-opacity=".8"/>`;
}

function emblem(kind, [x, y], r, c, w, rot) {
  const t = `transform="translate(${f(x)} ${f(y)}) rotate(${f(rot * 180 / Math.PI)})"`;
  const ink = `stroke="${INK}" stroke-width="${f(w * 0.7)}"`;
  switch (kind) {
    case 'star': return `<g ${t}><polygon points="${starPts(0, 0, r * 1.1, r * 0.45, 5)}" fill="${c}" ${ink}/></g>`;
    case 'spider': return `<g ${t} fill="${c}" stroke="${c}" stroke-width="${f(w * 0.6)}"><ellipse cy="${f(-r * 0.3)}" rx="${f(r * 0.22)}" ry="${f(r * 0.3)}"/><ellipse cy="${f(r * 0.4)}" rx="${f(r * 0.28)}" ry="${f(r * 0.5)}"/>` +
      [-1, 1].map(k => `<path d="M0 ${f(-r * 0.2)} L${f(k * r * 0.8)} ${f(-r * 0.9)} M0 0 L${f(k * r * 1.0)} ${f(-r * 0.3)} M0 ${f(r * 0.3)} L${f(k * r * 0.9)} ${f(r * 0.7)} M0 ${f(r * 0.5)} L${f(k * r * 0.6)} ${f(r * 1.3)}" fill="none"/>`).join('') + '</g>';
    case 'arc': return `<g ${t}><circle r="${f(r * 0.75)}" fill="#dffaff" ${ink}/><circle r="${f(r * 0.4)}" fill="#ffffff"/><circle r="${f(r * 1.3)}" fill="#8fe3ff" opacity=".35"/></g>`;
    case 'hourglass': return `<g ${t}><path d="M${f(-r * 0.6)} ${f(-r * 0.7)} H${f(r * 0.6)} L0 0 Z M${f(-r * 0.6)} ${f(r * 0.7)} H${f(r * 0.6)} L0 0 Z" fill="${c}" ${ink}/></g>`;
    case 'skull': return `<g ${t}><path d="${smooth([[0, -r * 1.1], [r * 0.9, -r * 0.5], [r * 0.7, r * 0.4], [r * 0.45, r * 1.3], [-r * 0.45, r * 1.3], [-r * 0.7, r * 0.4], [-r * 0.9, -r * 0.5]])}" fill="${c}" ${ink}/>` +
      `<ellipse cx="${f(-r * 0.38)}" cy="${f(-r * 0.1)}" rx="${f(r * 0.28)}" ry="${f(r * 0.3)}" fill="${INK}"/><ellipse cx="${f(r * 0.38)}" cy="${f(-r * 0.1)}" rx="${f(r * 0.28)}" ry="${f(r * 0.3)}" fill="${INK}"/>` +
      `<path d="M${f(-r * 0.35)} ${f(r * 0.7)} V${f(r * 1.25)} M0 ${f(r * 0.7)} V${f(r * 1.3)} M${f(r * 0.35)} ${f(r * 0.7)} V${f(r * 1.25)}" stroke="${INK}" stroke-width="${f(w * 0.6)}"/></g>`;
    case 'x': return `<g ${t}><circle r="${f(r)}" fill="${c}" ${ink}/><path d="M${f(-r * 0.55)} ${f(-r * 0.55)} L${f(r * 0.55)} ${f(r * 0.55)} M${f(r * 0.55)} ${f(-r * 0.55)} L${f(-r * 0.55)} ${f(r * 0.55)}" stroke="${INK}" stroke-width="${f(r * 0.3)}"/></g>`;
    case 'dd': return `<g ${t} fill="none" stroke="${c}" stroke-width="${f(w * 0.9)}"><path d="M${f(-r * 0.9)} ${f(-r * 0.6)} h${f(r * 0.5)} a${f(r * 0.5)} ${f(r * 0.6)} 0 0 1 0 ${f(r * 1.2)} h${f(-r * 0.5)} Z"/><path d="M${f(-r * 0.2)} ${f(-r * 0.6)} h${f(r * 0.5)} a${f(r * 0.5)} ${f(r * 0.6)} 0 0 1 0 ${f(r * 1.2)} h${f(-r * 0.5)} Z"/></g>`;
    case 'bolt': return `<g ${t}><polygon points="${pts([[r * 0.3, -r * 1.1], [-r * 0.6, r * 0.1], [-r * 0.05, r * 0.1], [-r * 0.35, r * 1.1], [r * 0.6, -r * 0.2], [r * 0.05, -r * 0.2]])}" fill="${c}" ${ink}/></g>`;
    case 'moon': return `<g ${t}><path d="M${f(r * 0.2)} ${f(-r)} A${f(r)} ${f(r)} 0 1 0 ${f(r * 0.2)} ${f(r)} A${f(r * 0.75)} ${f(r * 0.9)} 0 1 1 ${f(r * 0.2)} ${f(-r)} Z" fill="${c}" ${ink}/></g>`;
    case 'fire': return `<g ${t}><path d="M0 ${f(-r * 1.2)} C${f(r * 0.9)} ${f(-r * 0.2)} ${f(r * 0.7)} ${f(r * 1)} 0 ${f(r * 1)} C${f(-r * 0.7)} ${f(r * 1)} ${f(-r * 0.9)} ${f(-r * 0.2)} 0 ${f(-r * 1.2)} Z" fill="${c}" ${ink}/></g>`;
    case 'ring': return `<g ${t}><circle r="${f(r * 0.85)}" fill="none" stroke="${c}" stroke-width="${f(r * 0.3)}"/><circle r="${f(r * 1.0)}" fill="none" stroke="${INK}" stroke-width="${f(w * 0.5)}"/></g>`;
    case 'diamond': return `<g ${t}><polygon points="${pts([[0, -r], [r * 0.7, 0], [0, r], [-r * 0.7, 0]])}" fill="${c}" ${ink}/></g>`;
    case 'gem': return `<g ${t}><circle r="${f(r * 0.45)}" fill="${c}" ${ink}/><circle r="${f(r * 1.2)}" fill="${c}" opacity=".3"/></g>`;
    case 'wasp': return `<g ${t}><ellipse rx="${f(r * 0.4)}" ry="${f(r * 0.9)}" fill="${c}" ${ink}/><path d="M${f(-r * 0.4)} ${f(-r * 0.2)} H${f(r * 0.4)} M${f(-r * 0.4)} ${f(r * 0.2)} H${f(r * 0.4)}" stroke="${INK}" stroke-width="${f(w * 0.6)}"/></g>`;
    // ----- DC -----
    case 'bat': return `<g ${t}><polygon points="${pts(BAT.map(([x, y]) => [(x - 100) / 100 * r * 1.5, (y - 52) / 100 * r * 1.5]))}" fill="${c}" ${ink}/></g>`;
    case 'batoval': return `<g ${t}><ellipse rx="${f(r * 1.6)}" ry="${f(r * 0.95)}" fill="#f0c840" ${ink}/><polygon points="${pts(BAT.map(([x, y]) => [(x - 100) / 100 * r * 1.4, (y - 52) / 100 * r * 1.4]))}" fill="${c}"/></g>`;
    case 'super': return `<g ${t}><polygon points="${pts([[-r * 0.7, -r * 0.9], [r * 0.7, -r * 0.9], [r * 1.0, -r * 0.5], [0, r * 1.0], [-r * 1.0, -r * 0.5]])}" fill="${c}" ${ink}/>` +
      `<path d="M${f(r * 0.45)} ${f(-r * 0.62)} H${f(-r * 0.2)} C${f(-r * 0.55)} ${f(-r * 0.62)} ${f(-r * 0.55)} ${f(-r * 0.2)} ${f(-r * 0.2)} ${f(-r * 0.15)} L${f(r * 0.2)} ${f(-r * 0.05)} C${f(r * 0.5)} ${f(r * 0.05)} ${f(r * 0.4)} ${f(r * 0.42)} ${f(r * 0.05)} ${f(r * 0.42)} H${f(-r * 0.35)}" fill="none" stroke="#d8282e" stroke-width="${f(r * 0.24)}" stroke-linecap="round"/></g>`;
    case 'ww': return `<g ${t}>` + [-0.3, 0.3].map(dx => `<polyline points="${pts([[-0.6, -0.5], [-0.3, 0.5], [0, -0.2], [0.3, 0.5], [0.6, -0.5]].map(([x, y]) => [(x + dx) * r, y * r]))}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.32)}"/><polyline points="${pts([[-0.6, -0.5], [-0.3, 0.5], [0, -0.2], [0.3, 0.5], [0.6, -0.5]].map(([x, y]) => [(x + dx) * r, y * r]))}" fill="none" stroke="${c}" stroke-width="${f(r * 0.2)}"/>`).join('') + '</g>';
    case 'flash': case 'rflash': {
      const rev = kind === 'rflash';
      return `<g ${t}><circle r="${f(r)}" fill="${rev ? INK : '#ffffff'}" stroke="${rev ? '#d8282e' : '#e8c030'}" stroke-width="${f(r * 0.16)}"/>` +
        `<polygon points="${pts([[r * 0.3, -r * 0.95], [-r * 0.35, r * 0.05], [r * 0.02, r * 0.05], [-r * 0.3, r * 0.95], [r * 0.38, -r * 0.15], [r * 0.02, -r * 0.15], [r * 0.45, -r * 0.95]])}" fill="${rev ? '#d8282e' : '#f0c030'}" ${ink}/></g>`;
    }
    case 'lantern': case 'sinestro': {
      let o = '';
      if (kind === 'sinestro') for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.39; o += `<polygon points="${pts([[Math.cos(a - 0.2) * r * 0.6, Math.sin(a - 0.2) * r * 0.6], [Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15], [Math.cos(a + 0.2) * r * 0.6, Math.sin(a + 0.2) * r * 0.6]])}" fill="${c}" ${ink}/>`; }
      return `<g ${t}>${o}<circle r="${f(r * 0.55)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.32)}"/><circle r="${f(r * 0.55)}" fill="none" stroke="${c}" stroke-width="${f(r * 0.2)}"/>` +
        [-1, 1].map(k => `<rect x="${f(-r * 1.0)}" y="${f(k > 0 ? r * 0.62 : -r * 0.82)}" width="${f(r * 2)}" height="${f(r * 0.2)}" fill="${c}" ${ink}/>`).join('') + '</g>';
    }
    case 'omega': return `<g ${t}><path d="M${f(-r * 0.9)} ${f(r * 0.8)} H${f(-r * 0.35)} V${f(r * 0.55)} C${f(-r * 0.9)} ${f(r * 0.3)} ${f(-r * 0.9)} ${f(-r * 0.85)} 0 ${f(-r * 0.85)} C${f(r * 0.9)} ${f(-r * 0.85)} ${f(r * 0.9)} ${f(r * 0.3)} ${f(r * 0.35)} ${f(r * 0.55)} V${f(r * 0.8)} H${f(r * 0.9)}" fill="none" stroke="${INK}" stroke-width="${f(r * 0.34)}" stroke-linejoin="round"/>` +
      `<path d="M${f(-r * 0.9)} ${f(r * 0.8)} H${f(-r * 0.35)} V${f(r * 0.55)} C${f(-r * 0.9)} ${f(r * 0.3)} ${f(-r * 0.9)} ${f(-r * 0.85)} 0 ${f(-r * 0.85)} C${f(r * 0.9)} ${f(-r * 0.85)} ${f(r * 0.9)} ${f(r * 0.3)} ${f(r * 0.35)} ${f(r * 0.55)} V${f(r * 0.8)} H${f(r * 0.9)}" fill="none" stroke="${c}" stroke-width="${f(r * 0.2)}" stroke-linejoin="round"/></g>`;
    case 'question': return `<g ${t}><text y="${f(r * 0.7)}" font-family="Georgia, serif" font-weight="700" font-size="${f(r * 2.2)}" fill="${c}" text-anchor="middle" stroke="${INK}" stroke-width="${f(w * 0.6)}">?</text></g>`;
    case 'ha': return `<g ${t}><text y="${f(r * 0.4)}" font-family="Impact, sans-serif" font-size="${f(r * 1.2)}" fill="${c}" text-anchor="middle" stroke="${INK}" stroke-width="${f(w * 0.5)}">HA!</text></g>`;
    case 'R': return `<g ${t}><circle r="${f(r)}" fill="${c}" ${ink}/><text y="${f(r * 0.5)}" font-family="Impact, sans-serif" font-size="${f(r * 1.45)}" fill="#d8282e" text-anchor="middle" stroke="${INK}" stroke-width="${f(w * 0.4)}">R</text></g>`;
    case 'nightwing': return `<g ${t}><path d="M0 ${f(r * 0.5)} L${f(-r * 0.2)} ${f(r * 0.2)} L${f(-r * 1.7)} ${f(-r * 0.6)} L${f(-r * 0.1)} ${f(-r * 0.05)} L0 ${f(-r * 0.2)} L${f(r * 0.1)} ${f(-r * 0.05)} L${f(r * 1.7)} ${f(-r * 0.6)} L${f(r * 0.2)} ${f(r * 0.2)} Z" fill="${c}" ${ink}/></g>`;
    case 'hawk': return `<g ${t}><path d="M0 ${f(r * 0.9)} L${f(-r * 0.3)} ${f(-r * 0.1)} L${f(-r * 1.4)} ${f(-r * 0.7)} L${f(-r * 0.9)} ${f(r * 0.1)} L${f(-r * 0.3)} ${f(r * 0.3)} Z M0 ${f(r * 0.9)} L${f(r * 0.3)} ${f(-r * 0.1)} L${f(r * 1.4)} ${f(-r * 0.7)} L${f(r * 0.9)} ${f(r * 0.1)} L${f(r * 0.3)} ${f(r * 0.3)} Z" fill="${c}" ${ink}/><circle cy="${f(-r * 0.35)}" r="${f(r * 0.25)}" fill="${c}" ${ink}/></g>`;
    case 'scarab': return `<g ${t}><ellipse cy="${f(r * 0.15)}" rx="${f(r * 0.7)}" ry="${f(r * 0.9)}" fill="${c}" ${ink}/><path d="M0 ${f(-r * 0.75)} V${f(r * 1.05)}" stroke="${INK}" stroke-width="${f(w * 0.6)}"/><ellipse cy="${f(-r * 0.85)}" rx="${f(r * 0.35)}" ry="${f(r * 0.22)}" fill="${c}" ${ink}/></g>`;
    case 'dove': return `<g ${t}><path d="M${f(-r)} ${f(r * 0.1)} C${f(-r * 0.4)} ${f(-r * 0.3)} ${f(r * 0.2)} ${f(-r * 0.2)} ${f(r * 0.5)} ${f(r * 0.1)} L${f(r * 1.1)} ${f(-r * 0.1)} L${f(r * 0.8)} ${f(r * 0.35)} C${f(r * 0.2)} ${f(r * 0.6)} ${f(-r * 0.5)} ${f(r * 0.5)} ${f(-r)} ${f(r * 0.1)} Z M${f(-r * 0.1)} ${f(-r * 0.1)} L${f(r * 0.3)} ${f(-r * 1.0)} L${f(r * 0.5)} ${f(0)} Z" fill="${c}" ${ink}/></g>`;
    case 'legion': case 'lex': {
      const ring = kind === 'legion' ? `<circle r="${f(r)}" fill="${INK}"/><circle r="${f(r * 0.82)}" fill="none" stroke="${c}" stroke-width="${f(r * 0.28)}"/>`
        : `<polygon points="${pts([0, 1, 2, 3, 4, 5].map(i => [Math.cos(i * Math.PI / 3 + Math.PI / 6) * r, Math.sin(i * Math.PI / 3 + Math.PI / 6) * r]))}" fill="${INK}" stroke="${c}" stroke-width="${f(r * 0.14)}"/>`;
      return `<g ${t}>${ring}<path d="M${f(-r * 0.25)} ${f(-r * 0.45)} V${f(r * 0.4)} H${f(r * 0.4)}" fill="none" stroke="${c}" stroke-width="${f(r * 0.22)}"/></g>`;
    }
    default: return '';
  }
}

function wings(kind, at, facing, w, c) {
  const ink = `stroke="${INK}" stroke-width="${f(w)}" stroke-linejoin="round"`;
  if (kind === 'insect') return [-1, 1].map(k => `<g transform="translate(${f(at[0])} ${f(at[1] + 20)}) scale(${k} 1)"><ellipse cx="60" cy="-40" rx="70" ry="28" transform="rotate(-28 60 -40)" fill="${c}" fill-opacity=".55" ${ink}/><ellipse cx="50" cy="10" rx="50" ry="20" transform="rotate(18 50 10)" fill="${c}" fill-opacity=".45" ${ink}/></g>`).join('');
  // Mechanical wings: overlapping feathers.
  let o = '';
  [-1, 1].forEach(k => {
    let g = '';
    for (let i = 0; i < 7; i++) {
      const a = -0.9 + i * 0.22, len = 120 + i * 18;
      g += `<path d="M0 0 L${f(Math.cos(a) * len)} ${f(Math.sin(a) * len - 10)} L${f(Math.cos(a + 0.12) * (len - 12))} ${f(Math.sin(a + 0.12) * (len - 12))} Z" fill="${i % 2 ? c : mix(c, '#c03e3e', 0.2)}" ${ink}/>`;
    }
    o += `<g transform="translate(${f(at[0])} ${f(at[1] + 10)}) scale(${k} 1)">${g}</g>`;
  });
  return o;
}

function tentacles(sh, hip, facing, w, c) {
  let o = '';
  const base = [(sh[0] + hip[0]) / 2 - facing * 10, (sh[1] + hip[1]) / 2];
  [[-150, -120], [-170, 20], [120, -150], [150, 30]].forEach(([dx, dy], i) => {
    const e = [base[0] + dx, base[1] + dy], m = [base[0] + dx * 0.4, base[1] + dy * 0.2 - 40];
    o += `<path d="M${f(base[0])} ${f(base[1])} Q${f(m[0])} ${f(m[1])} ${f(e[0])} ${f(e[1])}" fill="none" stroke="${INK}" stroke-width="${f(w + 14)}" stroke-linecap="round"/>`;
    o += `<path d="M${f(base[0])} ${f(base[1])} Q${f(m[0])} ${f(m[1])} ${f(e[0])} ${f(e[1])}" fill="none" stroke="${c}" stroke-width="14" stroke-linecap="round" stroke-dasharray="10 3"/>`;
    const a = Math.atan2(e[1] - m[1], e[0] - m[0]);
    o += [-0.5, 0, 0.5].map(s => `<path d="M${f(e[0])} ${f(e[1])} l${f(Math.cos(a + s) * 22)} ${f(Math.sin(a + s) * 22)}" stroke="${INK}" stroke-width="${f(w + 4)}" stroke-linecap="round"/>`).join('') +
      `<circle cx="${f(e[0])}" cy="${f(e[1])}" r="6" fill="#ff4a4a" stroke="${INK}" stroke-width="${f(w)}"/>`;
  });
  return o;
}

function auraBehind(c, P, k) {
  const pts2 = Object.values(P);
  const xs = pts2.map(p => p[0]), ys = pts2.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + 50, ry = (Math.max(...ys) - Math.min(...ys)) / 2 + 50;
  const r = rng(3);
  let flames = '';
  for (let i = 0; i < 26; i++) {
    const a = i / 26 * Math.PI * 2, len = 30 + r() * 60;
    const bx = cx + Math.cos(a) * rx * 0.8, by = cy + Math.sin(a) * ry * 0.8;
    flames += `<path d="M${f(bx - 16)} ${f(by)} Q${f(bx + Math.cos(a) * len * 0.5)} ${f(by + Math.sin(a) * len * 0.5 - 20)} ${f(bx + Math.cos(a) * len)} ${f(by + Math.sin(a) * len - 30)} Q${f(bx + 10)} ${f(by - 10)} ${f(bx + 16)} ${f(by)} Z"/>`;
  }
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${c[0]}"/><g fill="${c[0]}" stroke="${INK}" stroke-width="2">${flames}</g><ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx * 0.8)}" ry="${f(ry * 0.85)}" fill="${c[1]}"/>`;
}

// Things held or worn at the hands.
function handProps(s, ha, hb, el, facing, w, sc) {
  const ink = `stroke="${INK}" stroke-width="${f(w)}" stroke-linejoin="round"`;
  let o = '';
  const p = s.prop;
  if (!p) return o;
  const a = Math.atan2(ha[1] - el[1], ha[0] - el[0]);
  const at = (d, off = 0) => [ha[0] + Math.cos(a) * d - Math.sin(a) * off, ha[1] + Math.sin(a) * d + Math.cos(a) * off];
  switch (p) {
    case 'claws': {
      for (let i = -1; i <= 1; i++) {
        const b = at(4, i * 6), e = at(70, i * 10);
        o += `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 5)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="#e8eef6" stroke-width="4.5" stroke-linecap="round"/>`;
      }
      const a2 = Math.atan2(hb[1] - el[1], hb[0] - el[0]);
      for (let i = -1; i <= 1; i++) {
        const b = [hb[0] - Math.sin(a2) * i * 6, hb[1] + Math.cos(a2) * i * 6], e = [hb[0] + Math.cos(a2) * 60 - Math.sin(a2) * i * 9, hb[1] + Math.sin(a2) * 60 + Math.cos(a2) * i * 9];
        o += `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 5)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="#e8eef6" stroke-width="4.5" stroke-linecap="round"/>`;
      }
      return o;
    }
    case 'shield': {
      const [x, y] = hb;
      return `<g transform="translate(${f(x)} ${f(y - 10)})"><circle r="46" fill="#c8434c" ${ink}/><circle r="36" fill="#eef1f6" ${ink}/><circle r="26" fill="#c8434c" ${ink}/><circle r="17" fill="#3f64b8" ${ink}/><polygon points="${starPts(0, 0, 15, 6, 5)}" fill="#ffffff" ${ink}/></g>`;
    }
    case 'hammer': {
      const [x, y] = ha;
      return `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(a * 180 / Math.PI - 90)})"><rect x="-5" y="-6" width="10" height="56" fill="#7a4a2a" ${ink}/><rect x="-30" y="44" width="60" height="38" rx="3" fill="#b8c2cc" ${ink}/><path d="M-26 50 H26" stroke="#ffffff" stroke-opacity=".6" stroke-width="3"/></g>`;
    }
    case 'bow': {
      const [x, y] = hb;
      return `<path d="M${f(x + 4)} ${f(y - 90)} Q${f(x + 60 * facing)} ${f(y)} ${f(x + 4)} ${f(y + 90)}" fill="none" stroke="${INK}" stroke-width="${f(w + 6)}"/><path d="M${f(x + 4)} ${f(y - 90)} Q${f(x + 60 * facing)} ${f(y)} ${f(x + 4)} ${f(y + 90)}" fill="none" stroke="#6a3a9a" stroke-width="6"/><path d="M${f(x + 4)} ${f(y - 90)} L${f(x + 4)} ${f(y + 90)}" stroke="${INK}" stroke-width="1.5"/>`;
    }
    case 'sword': case 'sai': case 'staff': case 'trident': case 'sceptre': case 'glaive': {
      const len = p === 'sai' ? 70 : p === 'sword' ? 150 : 210;
      const b = at(-(p === 'staff' || p === 'trident' || p === 'sceptre' ? len * 0.45 : 6)), e = at(len * (p === 'staff' || p === 'trident' || p === 'sceptre' ? 0.55 : 1));
      const col = p === 'sword' || p === 'sai' || p === 'glaive' ? '#e4eaf2' : '#d8b04a';
      o += `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 8)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${col}" stroke-width="7" stroke-linecap="round"/>`;
      if (p === 'trident') { const q = at(len * 0.55); o += `<path d="M${f(q[0] - Math.sin(a) * 22)} ${f(q[1] + Math.cos(a) * 22)} L${f(q[0] + Math.sin(a) * 22)} ${f(q[1] - Math.cos(a) * 22)}" stroke="${INK}" stroke-width="${f(w + 7)}"/><path d="M${f(q[0] - Math.sin(a) * 22)} ${f(q[1] + Math.cos(a) * 22)} l${f(Math.cos(a) * 36)} ${f(Math.sin(a) * 36)} M${f(q[0] + Math.sin(a) * 22)} ${f(q[1] - Math.cos(a) * 22)} l${f(Math.cos(a) * 36)} ${f(Math.sin(a) * 36)} M${f(q[0])} ${f(q[1])} l${f(Math.cos(a) * 44)} ${f(Math.sin(a) * 44)}" stroke="${INK}" stroke-width="${f(w + 7)}" stroke-linecap="round"/><path d="M${f(q[0] - Math.sin(a) * 22)} ${f(q[1] + Math.cos(a) * 22)} l${f(Math.cos(a) * 36)} ${f(Math.sin(a) * 36)} M${f(q[0] + Math.sin(a) * 22)} ${f(q[1] - Math.cos(a) * 22)} l${f(Math.cos(a) * 36)} ${f(Math.sin(a) * 36)} M${f(q[0])} ${f(q[1])} l${f(Math.cos(a) * 44)} ${f(Math.sin(a) * 44)}" stroke="#e8c050" stroke-width="6" stroke-linecap="round"/>`; }
      if (p === 'sceptre') { const q = at(len * 0.55); o += `<circle cx="${f(q[0])}" cy="${f(q[1])}" r="16" fill="#7fd0ff" ${ink}/><circle cx="${f(q[0])}" cy="${f(q[1])}" r="30" fill="#7fd0ff" opacity=".4"/>`; }
      if (p === 'sai') { const b2 = [hb[0], hb[1]], e2 = [hb[0] + Math.cos(a) * 70, hb[1] + Math.sin(a) * 70]; o += `<path d="M${f(b2[0])} ${f(b2[1])} L${f(e2[0])} ${f(e2[1])}" stroke="${INK}" stroke-width="${f(w + 8)}" stroke-linecap="round"/><path d="M${f(b2[0])} ${f(b2[1])} L${f(e2[0])} ${f(e2[1])}" stroke="${col}" stroke-width="7" stroke-linecap="round"/>`; }
      return o;
    }
    case 'gun': case 'blasters': {
      const g = (h, a2) => `<g transform="translate(${f(h[0])} ${f(h[1])}) rotate(${f(a2 * 180 / Math.PI)})"><rect x="-6" y="-9" width="46" height="14" rx="3" fill="#3a3a40" ${ink}/><rect x="-4" y="0" width="12" height="22" rx="2" fill="#2a2a2e" ${ink}/>${p === 'blasters' ? '<circle cx="44" cy="-2" r="7" fill="#ffb060" stroke="#17120f" stroke-width="2"/>' : ''}</g>`;
      return g(ha, a) + (p === 'blasters' ? g(hb, Math.atan2(hb[1] - el[1], hb[0] - el[0]) * 0 + (facing > 0 ? 0 : Math.PI)) : '');
    }
    case 'rings': {
      const [x, y] = ha;
      return [0, 1, 2, 3, 4].map(i => `<ellipse cx="${f(x - Math.cos(a) * i * 12)}" cy="${f(y - Math.sin(a) * i * 12)}" rx="7" ry="20" transform="rotate(${f(a * 180 / Math.PI)} ${f(x - Math.cos(a) * i * 12)} ${f(y - Math.sin(a) * i * 12)})" fill="none" stroke="#5ab8ff" stroke-width="5"/>`).join('');
    }
    case 'board': return '';
    case 'webline': { const [x, y] = ha; return `<path d="M${f(x)} ${f(y)} L${f(x + 90 * facing)} ${f(y - 900)}" stroke="#f4f6fa" stroke-width="3.5"/><path d="M${f(x)} ${f(y)} L${f(x + 90 * facing)} ${f(y - 900)}" stroke="${INK}" stroke-width="1" stroke-dasharray="2 10"/>`; }
    case 'gauntlet': {
      const [x, y] = ha;
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(sc(13))}" fill="#e2bd4c" ${ink}/>` + ['#e04848', '#4f7ae0', '#f0d040', '#5ad07a', '#b05ae0', '#ff9a3a'].map((c, i) => `<circle cx="${f(x - 8 + (i % 3) * 8)}" cy="${f(y - 5 + Math.floor(i / 3) * 10)}" r="3.2" fill="${c}" stroke="${INK}" stroke-width="1"/>`).join('');
    }
    case 'tophat': return '';
    // ----- DC -----
    case 'lasso': {
      const [x, y] = ha;
      const loops = [0, 1, 2].map(i => `<ellipse cx="${f(x + facing * 10)}" cy="${f(y + 26 + i * 6)}" rx="${f(26 - i * 4)}" ry="${f(12 - i * 2)}" fill="none" stroke="${INK}" stroke-width="${f(w + 4)}"/><ellipse cx="${f(x + facing * 10)}" cy="${f(y + 26 + i * 6)}" rx="${f(26 - i * 4)}" ry="${f(12 - i * 2)}" fill="none" stroke="#f0c850" stroke-width="3.5"/>`).join('');
      return loops + `<path d="M${f(x)} ${f(y)} C${f(x + facing * 80)} ${f(y - 60)} ${f(x + facing * 160)} ${f(y + 20)} ${f(x + facing * 230)} ${f(y - 30)}" fill="none" stroke="${INK}" stroke-width="${f(w + 4)}"/><path d="M${f(x)} ${f(y)} C${f(x + facing * 80)} ${f(y - 60)} ${f(x + facing * 160)} ${f(y + 20)} ${f(x + facing * 230)} ${f(y - 30)}" fill="none" stroke="#ffe27a" stroke-width="3.5"/>`;
    }
    case 'mace': {
      const e = at(80);
      let spikes = '';
      for (let i = 0; i < 8; i++) { const a2 = i / 8 * Math.PI * 2; spikes += `<path d="M${f(e[0])} ${f(e[1])} l${f(Math.cos(a2) * 30)} ${f(Math.sin(a2) * 30)}" stroke="${INK}" stroke-width="${f(w + 3)}" stroke-linecap="round"/>`; }
      return `<path d="M${f(ha[0])} ${f(ha[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 9)}" stroke-linecap="round"/><path d="M${f(ha[0])} ${f(ha[1])} L${f(e[0])} ${f(e[1])}" stroke="#8a6a3a" stroke-width="8" stroke-linecap="round"/>` +
        spikes + `<circle cx="${f(e[0])}" cy="${f(e[1])}" r="20" fill="#d8b050" ${ink}/>`;
    }
    case 'escrima': {
      const stick = (h, a2) => { const b = [h[0] - Math.cos(a2) * 8, h[1] - Math.sin(a2) * 8], e = [h[0] + Math.cos(a2) * 80, h[1] + Math.sin(a2) * 80]; return `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 8)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="#4aa0f0" stroke-width="7" stroke-linecap="round"/>`; };
      return stick(ha, a) + stick(hb, Math.atan2(hb[1] - el[1], hb[0] - el[0]) - 0.6);
    }
    case 'wand': {
      const e = at(60);
      return `<path d="M${f(ha[0])} ${f(ha[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="7" stroke-linecap="round"/><path d="M${f(at(48)[0])} ${f(at(48)[1])} L${f(e[0])} ${f(e[1])}" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round"/>` +
        `<polygon points="${starPts(e[0] + Math.cos(a) * 22, e[1] + Math.sin(a) * 22, 16, 4, 4)}" fill="#fff2a0" ${ink}/>`;
    }
    case 'whip': {
      const [x, y] = ha;
      const d = `M${f(x)} ${f(y)} C${f(x + facing * 90)} ${f(y + 60)} ${f(x + facing * 140)} ${f(y - 80)} ${f(x + facing * 240)} ${f(y - 20)} S${f(x + facing * 300)} ${f(y + 60)} ${f(x + facing * 340)} ${f(y + 30)}`;
      return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${f(w + 5)}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#3a3048" stroke-width="4" stroke-linecap="round"/>`;
    }
    case 'umbrella': {
      const b = at(-40), e = at(150), c1 = at(60, 18), c2 = at(60, -18);
      return `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 7)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="#2a2a30" stroke-width="6" stroke-linecap="round"/>` +
        `<polygon points="${pts([c1, at(140), c2])}" fill="#2a2a34" ${ink}/><path d="M${f(b[0])} ${f(b[1])} q${f(-facing * 18)} 14 ${f(-facing * 4)} 26" fill="none" stroke="${INK}" stroke-width="${f(w + 5)}"/>`;
    }
    case 'qcane': {
      const b = at(-150), e = at(60);
      const q = `M${f(e[0])} ${f(e[1])} c0 -40 ${f(facing * 46)} -40 ${f(facing * 46)} -76 c0 -30 ${f(-facing * 22)} -44 ${f(-facing * 40)} -44 c-18 0 ${f(-facing * 36)} 12 ${f(-facing * 36)} 30`;
      return `<path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="${INK}" stroke-width="${f(w + 8)}" stroke-linecap="round"/><path d="M${f(b[0])} ${f(b[1])} L${f(e[0])} ${f(e[1])}" stroke="#d8b040" stroke-width="7" stroke-linecap="round"/>` +
        `<path d="${q}" fill="none" stroke="${INK}" stroke-width="${f(w + 9)}" stroke-linecap="round"/><path d="${q}" fill="none" stroke="#5ac04a" stroke-width="8" stroke-linecap="round"/>`;
    }
    default: return o;
  }
}

module.exports = { figure, head, POSES, emblem };
