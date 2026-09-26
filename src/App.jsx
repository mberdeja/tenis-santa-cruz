import { useState, useEffect, useCallback, useRef } from "react";
import { db } from "./firebase";
import {
  collection, doc, onSnapshot,
  setDoc, deleteDoc, serverTimestamp
} from "firebase/firestore";
import {
  getAuth, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "firebase/auth";

const auth = getAuth();

// ─── PALETTE (basada en el logo: teal oscuro, blanco, grises cálidos) ─────────
const C = {
  bg:        "#f5f7f6",
  surface:   "#ffffff",
  card:      "#ffffff",
  border:    "#dde8e5",
  borderMd:  "#b8d0cc",
  teal:      "#1d5c5c",
  tealMd:    "#2a7a7a",
  tealLt:    "#e8f3f2",
  tealXlt:   "#f0f8f7",
  accent:    "#c8a84b",   // dorado del logo
  text:      "#1a2e2e",
  muted:     "#6b8f8e",
  mutedLt:   "#9bbfbe",
  white:     "#ffffff",
  win:       "#1d7a4a",
  winBg:     "#e8f5ee",
  lose:      "#b03030",
  loseBg:    "#fceaea",
  shadow:    "rgba(29,92,92,0.10)",
  shadowMd:  "rgba(29,92,92,0.18)",
};

const FONT_DISPLAY = "'Space Grotesk', sans-serif";
const FONT_BODY    = "'Inter', sans-serif";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── SECURITY: sanitize text input — strip HTML/scripts/injections ──────────
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[<>"'`]/g, "")           // strip HTML chars
    .replace(/javascript:/gi, "")         // no js: URIs
    .replace(/on\w+\s*=/gi, "")           // no onerror= etc
    .replace(/\s+/g, " ")                 // collapse whitespace
    .trim()
    .slice(0, 100);                        // max 100 chars
}

// ─── HEAD-TO-HEAD tiebreak among a subset of players ─────────────────────────
// Returns players sorted by: 1) H2H wins, 2) H2H set diff, 3) H2H pts diff
function headToHeadSort(playerSubset, allMatches) {
  const ids = playerSubset.map(p => p.id);
  // Filter only matches between players in this subset
  const h2hMatches = allMatches.filter(m =>
    m.result && ids.includes(m.p1) && ids.includes(m.p2)
  );
  const h2h = {};
  ids.forEach(id => { h2h[id] = { wins: 0, setsWon: 0, setsLost: 0, ptsWon: 0, ptsLost: 0 }; });
  h2hMatches.forEach(m => {
    const r = m.result;
    if (r.walkover) {
      h2h[r.winner].wins++;
    } else {
      h2h[r.winner].wins++;
      h2h[m.p1].setsWon  += r.p1Sets; h2h[m.p1].setsLost += r.p2Sets;
      h2h[m.p2].setsWon  += r.p2Sets; h2h[m.p2].setsLost += r.p1Sets;
      h2h[m.p1].ptsWon   += r.p1Pts;  h2h[m.p1].ptsLost  += r.p2Pts;
      h2h[m.p2].ptsWon   += r.p2Pts;  h2h[m.p2].ptsLost  += r.p1Pts;
    }
  });
  return [...playerSubset].sort((a, b) => {
    const ha = h2h[a.id], hb = h2h[b.id];
    if (hb.wins !== ha.wins) return hb.wins - ha.wins;
    const aDiff = ha.setsWon - ha.setsLost, bDiff = hb.setsWon - hb.setsLost;
    if (bDiff !== aDiff) return bDiff - aDiff;
    return (hb.ptsWon - hb.ptsLost) - (ha.ptsWon - ha.ptsLost);
  });
}

function isSetValid(a, b) {
  const na = parseInt(a), nb = parseInt(b);
  if (isNaN(na) || isNaN(nb) || na < 0 || nb < 0) return false;
  const hi = Math.max(na, nb), lo = Math.min(na, nb);
  // Ganador necesita al menos 11 puntos
  if (hi < 11) return false;
  // Ventaja mínima de 2
  if (hi - lo < 2) return false;
  // Si uno llegó a 11+, el otro no puede tener más de hi-2
  // Ej: 11-9 ✓, 12-10 ✓, 13-11 ✓, 7-13 ✗ (no puede ser 13 si el otro no llegó a 11)
  // El ganador es el primero que llega a 11 con ventaja de 2
  // Si hi > 11, el lo debe ser hi-2 exactamente (no puede haber más margen si ya se pasó)
  if (hi > 11 && hi - lo !== 2) return false;
  return true;
}

function setWinner(a, b) {
  // returns 1 or 2
  return parseInt(a) > parseInt(b) ? 1 : 2;
}

function generateGroupMatches(players) {
  const matches = [];
  const groups = [...new Set(players.map(p => p.group))].sort();
  groups.forEach(g => {
    const gp = players.filter(p => p.group === g);
    for (let i = 0; i < gp.length; i++)
      for (let j = i + 1; j < gp.length; j++)
        matches.push({ id: uid(), phase: "group", group: g, p1: gp[i].id, p2: gp[j].id, result: null });
  });
  return matches;
}

function computeGroupStats(players, matches) {
  const stats = {};
  players.forEach(p => { stats[p.id] = { ...p, wins: 0, losses: 0, setsWon: 0, setsLost: 0, ptsWon: 0, ptsLost: 0 }; });
  matches.filter(m => m.phase === "group" && m.result).forEach(m => {
    const r = m.result;
    if (r.walkover) {
      stats[r.winner].wins++;
      stats[r.loser].losses++;
    } else {
      stats[r.winner].wins++; stats[r.loser].losses++;
      stats[m.p1].setsWon += r.p1Sets; stats[m.p1].setsLost += r.p2Sets;
      stats[m.p2].setsWon += r.p2Sets; stats[m.p2].setsLost += r.p1Sets;
      stats[m.p1].ptsWon  += r.p1Pts;  stats[m.p1].ptsLost  += r.p2Pts;
      stats[m.p2].ptsWon  += r.p2Pts;  stats[m.p2].ptsLost  += r.p1Pts;
    }
  });
  return stats;
}

function sortGroup(players, stats, allMatches = []) {
  const mapped = [...players].map(p => stats[p.id]);
  // Primary sort by wins
  mapped.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if ((b.setsWon - b.setsLost) !== (a.setsWon - a.setsLost))
      return (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost);
    return (b.ptsWon - b.ptsLost) - (a.ptsWon - a.ptsLost);
  });
  // Find tied groups and apply head-to-head tiebreak
  let i = 0;
  while (i < mapped.length) {
    let j = i + 1;
    while (j < mapped.length && mapped[j].wins === mapped[i].wins) j++;
    if (j - i > 1) {
      // Group of tied players — apply H2H
      const tiedSlice = mapped.slice(i, j);
      const sorted = headToHeadSort(tiedSlice, allMatches);
      for (let k = 0; k < sorted.length; k++) mapped[i + k] = sorted[k];
    }
    i = j;
  }
  return mapped;
}

// Construye el bracket KO dinámicamente según cantidad de clasificados:
// 4 clasificados (8 jugadores, 2 grupos) → solo SF + Final + Bronce
// 8 clasificados (16 jugadores, 4 grupos) → QF + SF + Final + Bronce
// 12 clasificados (24 jugadores, 6 grupos) → R16 + QF + SF + Final + Bronce
function buildKOFromGroups(players, matches, numGroups) {
  const stats = computeGroupStats(players, matches);
  // Recoger top-2 de cada grupo en orden cruzado (1°A vs 2°B, etc.)
  const firsts = [], seconds = [];
  for (let g = 0; g < numGroups; g++) {
    const gp = players.filter(p => p.group === g);
    const sorted = sortGroup(gp, stats);
    if (sorted[0]) firsts.push(sorted[0]);
    if (sorted[1]) seconds.push(sorted[1]);
  }
  const classified = [...firsts, ...seconds]; // total: numGroups * 2
  const n = classified.length; // 4, 8, 12, 16...

  // Determinar fases necesarias según n
  // n=4 → SF only | n=8 → QF+SF | n=12/16 → R16+QF+SF
  let phases = [];
  if (n <= 4) {
    // Semifinales directamente con los 4 clasificados
    // Cruces: 1°A vs 2°B, 1°B vs 2°A
    const sf = [
      { id: uid(), phase: "sf", slot: 0, p1: firsts[0]?.id, p2: seconds[1]?.id, result: null },
      { id: uid(), phase: "sf", slot: 1, p1: firsts[1]?.id, p2: seconds[0]?.id, result: null },
    ];
    const final  = { id: uid(), phase: "final",  slot: 0, p1: null, p2: null, result: null };
    const bronze = { id: uid(), phase: "bronze", slot: 0, p1: null, p2: null, result: null };
    phases = [...sf, final, bronze];
  } else if (n <= 8) {
    // Cuartos de final: cruces cruzados 1°s vs 2°s de grupos contrarios
    const crossedPairs = [
      [firsts[0], seconds[1]],
      [firsts[1], seconds[0]],
      [firsts[2], seconds[3]],
      [firsts[3], seconds[2]],
    ];
    const qf = crossedPairs.map((p, i) => ({
      id: uid(), phase: "qf", slot: i, p1: p[0]?.id, p2: p[1]?.id, result: null
    }));
    const sf = [0,1].map(i => ({ id: uid(), phase: "sf", slot: i, p1: null, p2: null, result: null }));
    const final  = { id: uid(), phase: "final",  slot: 0, p1: null, p2: null, result: null };
    const bronze = { id: uid(), phase: "bronze", slot: 0, p1: null, p2: null, result: null };
    phases = [...qf, ...sf, final, bronze];
  } else {
    // 16 de final + QF + SF + Final + Bronce
    // Emparejar clasificados: 1°s vs 2°s cruzados
    const r16pairs = [];
    for (let i = 0; i < firsts.length; i++) {
      const opp = seconds[(i + Math.floor(seconds.length/2)) % seconds.length];
      r16pairs.push([firsts[i], opp]);
    }
    const r16 = r16pairs.map((p, i) => ({
      id: uid(), phase: "r16", slot: i, p1: p[0]?.id, p2: p[1]?.id, result: null
    }));
    const qfCount = Math.ceil(r16.length / 2);
    const qf = Array.from({length: qfCount}, (_, i) => ({
      id: uid(), phase: "qf", slot: i, p1: null, p2: null, result: null
    }));
    const sf = [0,1].map(i => ({ id: uid(), phase: "sf", slot: i, p1: null, p2: null, result: null }));
    const final  = { id: uid(), phase: "final",  slot: 0, p1: null, p2: null, result: null };
    const bronze = { id: uid(), phase: "bronze", slot: 0, p1: null, p2: null, result: null };
    phases = [...r16, ...qf, ...sf, final, bronze];
  }
  return phases;
}

function propagateKO(ko, matchId, result) {
  let updated = ko.map(m => m.id === matchId ? { ...m, result } : m);
  const scored = updated.find(m => m.id === matchId);
  const winner = result.winner;
  const loser  = winner === scored.p1 ? scored.p2 : scored.p1;

  const hasR16 = ko.some(m => m.phase === "r16");
  const hasQF  = ko.some(m => m.phase === "qf");

  if (scored.phase === "r16") {
    // Ganador va a QF: pares 0+1→QF slot 0, pares 2+3→QF slot 1, etc.
    const qfSlot = Math.floor(scored.slot / 2);
    const pos    = scored.slot % 2 === 0 ? "p1" : "p2";
    updated = updated.map(m => m.phase === "qf" && m.slot === qfSlot ? { ...m, [pos]: winner } : m);
  }

  if (scored.phase === "qf") {
    if (hasR16) {
      // QF → SF
      const sfSlot = Math.floor(scored.slot / 2);
      const pos    = scored.slot % 2 === 0 ? "p1" : "p2";
      updated = updated.map(m => m.phase === "sf" && m.slot === sfSlot ? { ...m, [pos]: winner } : m);
    } else {
      // QF → SF (sin R16): misma lógica
      const sfSlot = scored.slot < 2 ? 0 : 1;
      const pos    = scored.slot % 2 === 0 ? "p1" : "p2";
      updated = updated.map(m => m.phase === "sf" && m.slot === sfSlot ? { ...m, [pos]: winner } : m);
    }
  }

  if (scored.phase === "sf") {
    const pos = scored.slot === 0 ? "p1" : "p2";
    updated = updated.map(m => m.phase === "final"  ? { ...m, [pos]: winner } : m);
    updated = updated.map(m => m.phase === "bronze" ? { ...m, [pos]: loser  } : m);
  }

  return updated;
}

// ─── STORAGE (Firestore realtime) ─────────────────────────────────────────────
// loadTournaments y saveTournaments reemplazados por listener en tiempo real
// Ver hook useTournaments() en el componente Root

// ─── LOGO SVG ─────────────────────────────────────────────────────────────────
// Fiel al original: escudo pentagonal teal, texto arqueado "Asociación Departamental",
// dos paletas enfrentadas con pelota al centro, banner "TENIS DE MESA" + "SANTA CRUZ", cruz inferior
function Logo({ size = 64 }) {
  const s = size / 120; // scale factor
  return (
    <svg width={size} height={size} viewBox="0 0 120 130" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* ── Outer circle guide for arched text ── */}
      <defs>
        <path id="arcTop" d="M 18,62 A 44,44 0 1,1 102,62"/>
        <path id="arcInner" d="M 24,62 A 38,38 0 1,1 96,62"/>
      </defs>

      {/* ── Shield body – pentagon shape matching original ── */}
      {/* Wide top, angled sides, pointed bottom point */}
      <path d="M60 10 L100 26 L100 70 Q100 88 80 98 L60 110 L40 98 Q20 88 20 70 L20 26 Z"
        fill="#1d5c5c"/>
      {/* Subtle inner bevel */}
      <path d="M60 16 L94 30 L94 68 Q94 84 76 94 L60 104 L44 94 Q26 84 26 68 L26 30 Z"
        fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2"/>

      {/* ── Left paddle (tilted left ~25°, blade facing right/inward) ── */}
      <g transform="rotate(-28, 42, 52)">
        {/* Blade */}
        <ellipse cx="42" cy="44" rx="13" ry="17" fill="#3a9090" stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
        {/* Rubber surface lines */}
        <ellipse cx="42" cy="44" rx="9" ry="12" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.6"/>
        {/* Handle */}
        <rect x="39" y="59" width="6" height="16" rx="3" fill="#145050"/>
        <rect x="40.5" y="60" width="3" height="14" rx="1.5" fill="#1a6060" opacity="0.5"/>
      </g>

      {/* ── Right paddle (tilted right ~25°, blade facing left/inward) ── */}
      <g transform="rotate(28, 78, 52)">
        <ellipse cx="78" cy="44" rx="13" ry="17" fill="#3a9090" stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
        <ellipse cx="78" cy="44" rx="9" ry="12" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.6"/>
        <rect x="75" y="59" width="6" height="16" rx="3" fill="#145050"/>
        <rect x="76.5" y="60" width="3" height="14" rx="1.5" fill="#1a6060" opacity="0.5"/>
      </g>

      {/* ── Ball at center-top between the two paddle blades ── */}
      <circle cx="60" cy="34" r="8" fill="white" opacity="0.95"/>
      {/* Ball seam curve */}
      <path d="M53 31 Q60 39 67 31" stroke="#ccc" strokeWidth="0.8" fill="none"/>
      <path d="M53 37 Q60 29 67 37" stroke="#ccc" strokeWidth="0.8" fill="none"/>

      {/* ── "TENIS DE MESA" text block in shield center ── */}
      <text x="60" y="76" textAnchor="middle" fill="white" fontSize="10.5" fontWeight="800"
        fontFamily="'Space Grotesk', Arial, sans-serif" letterSpacing="0.5">TENIS DE MESA</text>

      {/* ── Ribbon banner "SANTA CRUZ" ── */}
      {/* Main ribbon */}
      <path d="M24 82 L96 82 L96 94 L24 94 Z" fill="#c8a84b"/>
      {/* Left notch */}
      <path d="M24 82 L18 88 L24 94 Z" fill="#a8883a"/>
      {/* Right notch */}
      <path d="M96 82 L102 88 L96 94 Z" fill="#a8883a"/>
      {/* Ribbon border lines */}
      <line x1="24" y1="82" x2="96" y2="82" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"/>
      <line x1="24" y1="94" x2="96" y2="94" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"/>
      {/* Decorative dots */}
      <circle cx="30" cy="88" r="2" fill="#1d5c5c" opacity="0.7"/>
      <circle cx="90" cy="88" r="2" fill="#1d5c5c" opacity="0.7"/>
      <text x="60" y="91.5" textAnchor="middle" fill="#1d5c5c" fontSize="8.5" fontWeight="800"
        fontFamily="'Space Grotesk', Arial, sans-serif" letterSpacing="1.5">SANTA CRUZ</text>

      {/* ── Maltese / decorative cross at shield tip ── */}
      <g transform="translate(60, 106)">
        <rect x="-1.5" y="-6" width="3" height="12" rx="0.5" fill="#c8a84b"/>
        <rect x="-6" y="-1.5" width="12" height="3" rx="0.5" fill="#c8a84b"/>
        <rect x="-1" y="-1" width="2" height="2" fill="#c8a84b"/>
      </g>

      {/* ── Arched text "Asociación Departamental" ── */}
      <text fontSize="7.2" fontWeight="700" fill="#1d5c5c" fontFamily="'Space Grotesk', Arial, sans-serif" letterSpacing="0.3">
        <textPath href="#arcTop" startOffset="8%">Asociación Departamental</textPath>
      </text>
    </svg>
  );
}

// ─── SCORE MODAL ──────────────────────────────────────────────────────────────
function ScoreModal({ match, players, onSave, onClose }) {
  const p1 = players.find(p => p.id === match.p1);
  const p2 = players.find(p => p.id === match.p2);
  const [sets, setSets] = useState(
    match.result?.rawSets || Array.from({ length: 7 }, () => ({ p1: "", p2: "" }))
  );
  const [activeWO, setActiveWO] = useState(null); // walkover: p1id | p2id

  // Compute current score
  let p1Sets = 0, p2Sets = 0, p1Pts = 0, p2Pts = 0;
  sets.forEach(s => {
    const a = parseInt(s.p1), b = parseInt(s.p2);
    if (!isNaN(a) && !isNaN(b) && isSetValid(s.p1, s.p2)) {
      if (a > b) p1Sets++; else p2Sets++;
      p1Pts += a; p2Pts += b;
    }
  });
  const winner = p1Sets === 3 ? match.p1 : p2Sets === 3 ? match.p2 : null;

  const handleSave = () => {
    if (activeWO) {
      const loser = activeWO === match.p1 ? match.p2 : match.p1;
      onSave({ winner: activeWO, loser, walkover: true, p1Sets: 0, p2Sets: 0, p1Pts: 0, p2Pts: 0, rawSets: [] });
    } else if (winner) {
      const loser = winner === match.p1 ? match.p2 : match.p1;
      onSave({ winner, loser, p1Sets, p2Sets, p1Pts, p2Pts, rawSets: sets });
    }
  };

  const canSave = !!activeWO || !!winner;

  // Which sets are still editable (stop after one player reaches 3)
  const activeSets = sets.map((s, i) => {
    let cs1 = 0, cs2 = 0;
    for (let j = 0; j < i; j++) {
      if (isSetValid(sets[j].p1, sets[j].p2)) {
        parseInt(sets[j].p1) > parseInt(sets[j].p2) ? cs1++ : cs2++;
      }
    }
    return cs1 < 3 && cs2 < 3;
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(26,46,46,0.55)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}>
      <div style={{ background:C.white, borderRadius:16, padding:32, width:380, boxShadow:`0 20px 60px ${C.shadowMd}`, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
          <div>
            <h3 style={{ margin:0, color:C.teal, fontFamily:FONT_DISPLAY, fontSize:18 }}>Resultado del partido</h3>
            <p style={{ margin:"4px 0 0", color:C.muted, fontSize:12 }}>Al mejor de 5 sets · mínimo 11 pts con ventaja de 2</p>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:20, lineHeight:1 }}>×</button>
        </div>

        {/* Players header */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", gap:8, marginBottom:20, padding:"12px 16px", background:C.tealXlt, borderRadius:10 }}>
          <span style={{ color:C.teal, fontWeight:700, fontSize:14 }}>{p1?.name}</span>
          <span style={{ color:C.mutedLt, fontSize:12 }}>vs</span>
          <span style={{ color:C.teal, fontWeight:700, fontSize:14, textAlign:"right" }}>{p2?.name}</span>
        </div>

        {/* Walkover */}
        <div style={{ marginBottom:20 }}>
          <p style={{ margin:"0 0 8px", fontSize:12, color:C.muted, fontWeight:600, letterSpacing:.5 }}>WALK OVER (ausencia)</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[match.p1, match.p2].map(pid => {
              const pl = players.find(p => p.id === pid);
              const active = activeWO === pid;
              return (
                <button key={pid} onClick={() => setActiveWO(active ? null : pid)} style={{
                  padding:"9px 12px", borderRadius:8, border:`1.5px solid ${active ? C.lose : C.border}`,
                  background: active ? C.loseBg : C.bg, color: active ? C.lose : C.muted,
                  cursor:"pointer", fontSize:13, fontWeight: active ? 700 : 400, transition:"all .15s"
                }}>
                  WO — {pl?.name}
                </button>
              );
            })}
          </div>
        </div>

        {!activeWO && (
          <>
            <p style={{ margin:"0 0 10px", fontSize:12, color:C.muted, fontWeight:600, letterSpacing:.5 }}>SETS</p>
            {sets.map((s, i) => {
              if (!activeSets[i] && s.p1 === "" && s.p2 === "") return null;
              const valid = isSetValid(s.p1, s.p2);
              const sw = valid ? setWinner(s.p1, s.p2) : 0;
              return (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, opacity: activeSets[i] ? 1 : 0.5 }}>
                  <span style={{ color:C.mutedLt, fontSize:11, width:42, flexShrink:0 }}>Set {i+1}</span>
                  {[{val:s.p1, key:"p1", win:sw===1}, {val:s.p2, key:"p2", win:sw===2}].map((side, si) => (
                    <input key={si} type="number" min={0} max={99} value={side.val}
                      disabled={!activeSets[i]}
                      onChange={e => setSets(prev => prev.map((x,j) => j===i ? {...x, [side.key]: e.target.value} : x))}
                      style={{
                        width:52, padding:"7px 0", textAlign:"center", fontSize:18, fontWeight:700,
                        border:`1.5px solid ${side.win ? C.teal : valid && !side.win ? C.border : C.border}`,
                        borderRadius:8, background: side.win ? C.tealLt : C.bg,
                        color: side.win ? C.teal : C.text, outline:"none",
                      }}
                    />
                  ))}
                  {valid && <span style={{ fontSize:11, color:C.mutedLt }}>{s.p1}–{s.p2}</span>}
                </div>
              );
            })}

            {/* Live score */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", padding:"12px 16px", marginTop:12, background:C.tealXlt, borderRadius:10, alignItems:"center" }}>
              <span style={{ color: winner===match.p1 ? C.teal : C.muted, fontWeight:700, fontSize:22 }}>{p1Sets}</span>
              <span style={{ color:C.mutedLt, fontSize:11 }}>SETS</span>
              <span style={{ color: winner===match.p2 ? C.teal : C.muted, fontWeight:700, fontSize:22, textAlign:"right" }}>{p2Sets}</span>
            </div>
            {winner && (
              <div style={{ marginTop:8, textAlign:"center", color:C.win, fontWeight:700, fontSize:13 }}>
                🏆 Gana {players.find(p=>p.id===winner)?.name}
              </div>
            )}
          </>
        )}

        <div style={{ display:"flex", gap:10, marginTop:24 }}>
          <button onClick={onClose} style={{ flex:1, padding:"11px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:9, color:C.muted, cursor:"pointer", fontSize:14 }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={!canSave} style={{
            flex:2, padding:"11px", background: canSave ? C.teal : C.border, border:"none",
            borderRadius:9, color: canSave ? C.white : C.muted, fontWeight:700, cursor: canSave ? "pointer" : "not-allowed", fontSize:14
          }}>
            Guardar resultado
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TOURNAMENT HOME (list) ────────────────────────────────────────────────────
function TournamentHome({ tournaments, onCreate, onOpen, onDelete, onLogout, userEmail }) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [tournType, setTournType] = useState("groups"); // "groups" | "roundrobin"
  const [numPlayers, setNumPlayers] = useState(8);
  const [numGroups, setNumGroups] = useState(2);
  const [playerData, setPlayerData] = useState(
    Array.from({length:8}, (_, i) => ({ name: `Jugador ${i+1}`, group: 0 }))
  );

  useEffect(() => {
    setPlayerData(prev => Array.from({length:numPlayers}, (_, i) => ({
      name: prev[i]?.name || `Jugador ${i+1}`,
      group: tournType === "roundrobin" ? 0 : Math.min(prev[i]?.group ?? 0, numGroups - 1),
    })));
  }, [numPlayers, numGroups, tournType]);

  const setPlayerName = (i, val) => {
    const clean = sanitize(val);
    setPlayerData(prev => prev.map((p, j) => j === i ? { ...p, name: clean } : p));
  };
  const setPlayerGroup = (i, val) => {
    setPlayerData(prev => prev.map((p, j) => j === i ? { ...p, group: parseInt(val) } : p));
  };

  const handleCreate = () => {
    const cleanName = sanitize(name);
    if (!cleanName) return;
    const ng = tournType === "roundrobin" ? 1 : numGroups;
    const players = playerData.slice(0, numPlayers).map((pd, i) => ({
      id: uid(),
      name: pd.name || `Jugador ${i+1}`,
      group: tournType === "roundrobin" ? 0 : Math.min(pd.group, ng - 1),
    }));
    onCreate({
      id: uid(), name: cleanName, createdAt: Date.now(),
      phase: "setup", tournType,
      players, matches: [], koMatches: [], numGroups: ng,
    });
    setShowNew(false); setName(""); setNumPlayers(8); setNumGroups(2);
    setPlayerData(Array.from({length:8}, (_, i) => ({ name: `Jugador ${i+1}`, group: 0 })));
  };

  const statusLabel = (t) => {
    if (t.phase === "setup") return { label: "Sin iniciar", color: C.muted };
    if (t.phase === "roundrobin") {
      const allDone = t.matches?.every(m => m.result);
      return allDone ? { label: "Finalizado 🏆", color: C.accent } : { label: "Todos contra todos", color: C.tealMd };
    }
    if (t.phase === "groups") return { label: "Fase de grupos", color: C.tealMd };
    if (t.phase === "knockout") {
      const champ = t.koMatches?.find(m=>m.phase==="final")?.result?.winner;
      return champ
        ? { label: "Finalizado 🏆", color: C.accent }
        : { label: "Eliminación directa", color: C.tealMd };
    }
    return { label: "–", color: C.muted };
  };

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:FONT_BODY }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <Watermark/>

      {/* Hero header */}
      <header style={{ background:C.teal, padding:"40px 24px 36px" }}>
        <div style={{ maxWidth:860, margin:"0 auto", display:"flex", alignItems:"center", gap:20 }}>
          <Logo size={72} />
          <div>
            <p style={{ margin:"0 0 4px", color:"rgba(255,255,255,0.6)", fontSize:12, letterSpacing:1.5, fontWeight:600 }}>ASOCIACIÓN DEPARTAMENTAL</p>
            <h1 style={{ margin:0, color:C.white, fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:28, lineHeight:1.1 }}>
              Tenis de Mesa<br/>
              <span style={{ color:C.accent }}>Santa Cruz</span>
            </h1>
            <p style={{ margin:"8px 0 0", color:"rgba(255,255,255,0.55)", fontSize:13 }}>Sistema de gestión de torneos</p>
          </div>
        </div>
      </header>

      <main style={{ maxWidth:860, margin:"0 auto", padding:"32px 24px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <h2 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:20 }}>Torneos activos</h2>
          <div style={{ display:"flex", gap:10, alignItems:"center" }}>
            <span style={{ fontSize:12, color:C.muted }}>{userEmail}</span>
            <button onClick={onLogout} style={{ padding:"8px 14px", background:"transparent", border:`1px solid ${C.border}`, borderRadius:9, color:C.muted, cursor:"pointer", fontSize:13 }}>
              Salir
            </button>
            <button onClick={() => setShowNew(true)} style={{
            padding:"10px 20px", background:C.teal, border:"none", borderRadius:10,
            color:C.white, fontWeight:700, cursor:"pointer", fontSize:14,
            boxShadow:`0 4px 14px ${C.shadow}`, display:"flex", alignItems:"center", gap:6
          }}>
            + Nuevo torneo
          </button>
          </div>
        </div>

        {tournaments.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 24px", color:C.muted }}>
            <Logo size={56} />
            <p style={{ marginTop:16, fontSize:15 }}>No hay torneos creados.<br/>Creá uno para empezar.</p>
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:16 }}>
          {tournaments.map(t => {
            const st = statusLabel(t);
            const champ = t.koMatches?.find(m=>m.phase==="final")?.result?.winner;
            const champName = t.players?.find(p=>p.id===champ)?.name;
            return (
              <div key={t.id} style={{
                background:C.white, borderRadius:14, border:`1px solid ${C.border}`,
                padding:20, boxShadow:`0 2px 12px ${C.shadow}`, cursor:"pointer",
                transition:"box-shadow .2s, transform .2s",
              }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow=`0 6px 24px ${C.shadowMd}`; e.currentTarget.style.transform="translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow=`0 2px 12px ${C.shadow}`; e.currentTarget.style.transform="translateY(0)"; }}
              >
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
                  <span style={{ fontSize:11, fontWeight:700, color:st.color, background:st.color+"18", padding:"3px 9px", borderRadius:20, letterSpacing:.5 }}>
                    {st.label}
                  </span>
                  <button onClick={e=>{e.stopPropagation(); onDelete(t.id)}} style={{ background:"none", border:"none", color:C.mutedLt, cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
                </div>
                <h3 style={{ margin:"0 0 6px", fontFamily:FONT_DISPLAY, color:C.teal, fontSize:17 }}>{t.name}</h3>
                <p style={{ margin:"0 0 14px", color:C.muted, fontSize:12 }}>
                  {t.players?.length} jugadores · {t.tournType === "roundrobin" ? "Todos contra todos" : `${t.numGroups} grupos`}
                </p>
                {champName && (
                  <div style={{ fontSize:12, color:C.accent, fontWeight:700, marginBottom:10 }}>🏆 {champName}</div>
                )}
                <button onClick={() => onOpen(t.id)} style={{
                  width:"100%", padding:"9px", background:C.tealLt, border:`1px solid ${C.teal}22`,
                  borderRadius:8, color:C.teal, fontWeight:700, cursor:"pointer", fontSize:13
                }}>
                  {t.phase === "setup" ? "Configurar →" : "Ver torneo →"}
                </button>
              </div>
            );
          })}
        </div>
      </main>

      {/* NEW TOURNAMENT MODAL */}
      {showNew && (
        <div style={{ position:"fixed", inset:0, background:"rgba(26,46,46,0.55)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div style={{ background:C.white, borderRadius:16, padding:32, width:"100%", maxWidth:520, maxHeight:"90vh", overflowY:"auto", boxShadow:`0 20px 60px ${C.shadowMd}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
              <h3 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:20 }}>Nuevo torneo</h3>
              <button onClick={()=>setShowNew(false)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:22 }}>×</button>
            </div>

            <label style={{ display:"block", marginBottom:6, fontSize:13, color:C.teal, fontWeight:600 }}>Nombre del torneo</label>
            <input value={name} onChange={e=>setName(sanitize(e.target.value))} placeholder="Ej. Copa Santa Cruz 2025"
              maxLength={80}
              style={{ width:"100%", padding:"10px 14px", borderRadius:9, border:`1.5px solid ${C.border}`, fontSize:14, color:C.text, marginBottom:20, boxSizing:"border-box", outline:"none" }}/>

            {/* Tipo de torneo */}
            <label style={{ display:"block", marginBottom:10, fontSize:13, color:C.teal, fontWeight:600 }}>Formato</label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
              {[
                { val:"groups", label:"Por grupos", desc:"Fase de grupos + eliminatorias" },
                { val:"roundrobin", label:"Todos contra todos", desc:"Un solo grupo, gana el mejor" },
              ].map(opt => (
                <div key={opt.val} onClick={() => setTournType(opt.val)} style={{
                  padding:"12px 14px", borderRadius:10, border:`1.5px solid ${tournType===opt.val ? C.teal : C.border}`,
                  background: tournType===opt.val ? C.tealLt : C.bg, cursor:"pointer",
                }}>
                  <p style={{ margin:0, fontWeight:700, color: tournType===opt.val ? C.teal : C.text, fontSize:13 }}>{opt.label}</p>
                  <p style={{ margin:"3px 0 0", fontSize:11, color:C.muted }}>{opt.desc}</p>
                </div>
              ))}
            </div>

            {/* Cantidad de jugadores */}
            <label style={{ display:"block", marginBottom:8, fontSize:13, color:C.teal, fontWeight:600 }}>Cantidad de jugadores</label>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:20 }}>
              {[4,6,8,10,12,16,20,24,32].map(n => (
                <button key={n} onClick={()=>setNumPlayers(n)} style={{
                  padding:"6px 14px", borderRadius:8, border:`1.5px solid ${numPlayers===n ? C.teal : C.border}`,
                  background: numPlayers===n ? C.tealLt : C.bg, color: numPlayers===n ? C.teal : C.muted,
                  cursor:"pointer", fontWeight: numPlayers===n ? 700 : 400, fontSize:13
                }}>{n}</button>
              ))}
            </div>

            {/* Cantidad de grupos — solo si es por grupos */}
            {tournType === "groups" && (
              <>
                <label style={{ display:"block", marginBottom:8, fontSize:13, color:C.teal, fontWeight:600 }}>Cantidad de grupos</label>
                <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:20 }}>
                  {[2,3,4,5,6,8].filter(g => g <= numPlayers).map(g => (
                    <button key={g} onClick={()=>setNumGroups(g)} style={{
                      padding:"6px 14px", borderRadius:8, border:`1.5px solid ${numGroups===g ? C.teal : C.border}`,
                      background: numGroups===g ? C.tealLt : C.bg, color: numGroups===g ? C.teal : C.muted,
                      cursor:"pointer", fontWeight: numGroups===g ? 700 : 400, fontSize:13
                    }}>Grupo {g}</button>
                  ))}
                </div>
              </>
            )}

            {/* Jugadores */}
            <label style={{ display:"block", marginBottom:8, fontSize:13, color:C.teal, fontWeight:600 }}>Jugadores</label>
            <div style={{ display:"grid", gridTemplateColumns: tournType==="groups" ? "1fr 1fr" : "1fr 1fr", gap:8, marginBottom:24 }}>
              {Array.from({length:numPlayers}, (_,i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"7px 10px", background:C.bg, borderRadius:8, border:`1px solid ${C.border}` }}>
                  <span style={{ color:C.mutedLt, fontSize:11, minWidth:16 }}>{i+1}</span>
                  <input
                    value={playerData[i]?.name || ""}
                    onChange={e => setPlayerName(i, e.target.value)}
                    maxLength={50}
                    style={{ flex:1, background:"none", border:"none", outline:"none", color:C.text, fontSize:12 }}
                    placeholder={`Jugador ${i+1}`}
                  />
                  {tournType === "groups" && (
                    <select
                      value={playerData[i]?.group ?? 0}
                      onChange={e => setPlayerGroup(i, e.target.value)}
                      style={{ background:C.tealLt, border:`1px solid ${C.teal}33`, borderRadius:6, color:C.teal, fontSize:11, fontWeight:600, padding:"2px 4px", cursor:"pointer", outline:"none" }}
                    >
                      {Array.from({length:numGroups}, (_, g) => (
                        <option key={g} value={g}>G{g+1}</option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>

            <button onClick={handleCreate} disabled={!name.trim()} style={{
              width:"100%", padding:"13px", background: name.trim() ? C.teal : C.border, border:"none",
              borderRadius:10, color: name.trim() ? C.white : C.muted, fontWeight:700, fontSize:15,
              cursor: name.trim() ? "pointer" : "not-allowed",
            }}>
              Crear torneo →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ROUND ROBIN VIEW ────────────────────────────────────────────────────────
function RoundRobinView({ tournament, onUpdate }) {
  const { players, matches } = tournament;
  const [modal, setModal] = useState(null);

  const handleScore = (matchId, result) => {
    const newMatches = matches.map(m => m.id === matchId ? { ...m, result } : m);
    const allDone = newMatches.every(m => m.result);
    onUpdate({ ...tournament, matches: newMatches, phase: allDone ? "roundrobin" : "roundrobin" });
    setModal(null);
  };

  // Full stats with H2H tiebreak
  const stats = {};
  players.forEach(p => { stats[p.id] = { ...p, wins:0, losses:0, setsWon:0, setsLost:0, ptsWon:0, ptsLost:0 }; });
  matches.filter(m => m.result).forEach(m => {
    const r = m.result;
    if (r.walkover) { stats[r.winner].wins++; stats[r.loser].losses++; }
    else {
      stats[r.winner].wins++; stats[r.loser].losses++;
      stats[m.p1].setsWon += r.p1Sets; stats[m.p1].setsLost += r.p2Sets;
      stats[m.p2].setsWon += r.p2Sets; stats[m.p2].setsLost += r.p1Sets;
      stats[m.p1].ptsWon  += r.p1Pts;  stats[m.p1].ptsLost  += r.p2Pts;
      stats[m.p2].ptsWon  += r.p2Pts;  stats[m.p2].ptsLost  += r.p1Pts;
    }
  });

  const sorted = sortGroup(players, stats, matches);
  const allDone = matches.every(m => m.result);
  const played = matches.filter(m => m.result).length;

  return (
    <div>
      {modal && <ScoreModal match={modal} players={players} onSave={r=>handleScore(modal.id,r)} onClose={()=>setModal(null)}/>}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <div>
          <h2 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Todos contra todos</h2>
          <p style={{ margin:"4px 0 0", color:C.muted, fontSize:12 }}>{played} de {matches.length} partidos jugados</p>
        </div>
        {allDone && <span style={{ fontSize:12, color:C.win, background:C.winBg, padding:"6px 14px", borderRadius:20, fontWeight:700 }}>✓ Torneo completado</span>}
      </div>

      {/* Standings table */}
      <div style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 2px 10px ${C.shadow}`, marginBottom:24 }}>
        <div style={{ padding:"10px 16px", background:C.teal }}>
          <span style={{ color:C.white, fontWeight:700, fontFamily:FONT_DISPLAY, fontSize:14 }}>Tabla de posiciones</span>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"32px 1fr 36px 36px 36px 60px 70px", padding:"8px 16px", fontSize:10, color:C.mutedLt, fontWeight:700, letterSpacing:.5, borderBottom:`1px solid ${C.border}`, gap:4 }}>
          <span>#</span><span>JUGADOR</span><span style={{textAlign:"center"}}>PJ</span><span style={{textAlign:"center"}}>G</span><span style={{textAlign:"center"}}>P</span><span style={{textAlign:"center"}}>SETS</span><span style={{textAlign:"center"}}>PUNTOS</span>
        </div>
        {sorted.map((p, rank) => (
          <div key={p.id} style={{ display:"grid", gridTemplateColumns:"32px 1fr 36px 36px 36px 60px 70px", padding:"10px 16px", gap:4, alignItems:"center", background: rank===0 ? C.tealXlt : rank%2===0 ? C.bg : C.white, borderBottom:`1px solid ${C.border}33`, borderLeft:`3px solid ${rank===0?C.teal:"transparent"}` }}>
            <span style={{ fontWeight:700, color: rank===0?C.teal:rank===1?"#9e9e9e":rank===2?"#a0714f":C.mutedLt, fontSize:rank<3?16:13, textAlign:"center" }}>
              {rank===0?"🥇":rank===1?"🥈":rank===2?"🥉":rank+1}
            </span>
            <span style={{ fontSize:13, color:C.text, fontWeight: rank<3?700:400 }}>{p.name}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.wins+p.losses}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.win, fontWeight:600 }}>{p.wins}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.lose }}>{p.losses}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.setsWon}-{p.setsLost}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.ptsWon}-{p.ptsLost}</span>
          </div>
        ))}
      </div>

      {/* All matches */}
      <div style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 2px 10px ${C.shadow}` }}>
        <div style={{ padding:"10px 16px", background:C.teal }}>
          <span style={{ color:C.white, fontWeight:700, fontFamily:FONT_DISPLAY, fontSize:14 }}>Partidos</span>
        </div>
        <div style={{ padding:"10px 14px" }}>
          {matches.map(m => {
            const pp1 = players.find(p=>p.id===m.p1), pp2 = players.find(p=>p.id===m.p2);
            const r = m.result;
            return (
              <div key={m.id} onClick={()=>setModal(m)} style={{
                display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", gap:6,
                padding:"9px 10px", borderRadius:8, marginBottom:6, cursor:"pointer",
                background: r ? C.tealXlt : C.bg, border:`1px solid ${r ? C.teal+"22" : C.border}`,
                transition:"all .15s",
              }}>
                <span style={{ fontSize:13, color: r?.winner===m.p1?C.teal:C.muted, fontWeight: r?.winner===m.p1?700:400 }}>{pp1?.name}</span>
                <span style={{ fontSize:13, color:C.teal, fontWeight:700, minWidth:50, textAlign:"center" }}>
                  {r ? (r.walkover ? "W/O" : `${r.p1Sets}–${r.p2Sets}`) : "vs"}
                </span>
                <span style={{ fontSize:13, color: r?.winner===m.p2?C.teal:C.muted, fontWeight: r?.winner===m.p2?700:400, textAlign:"right" }}>{pp2?.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── GROUP PHASE VIEW ─────────────────────────────────────────────────────────
function GroupPhaseView({ tournament, onUpdate }) {
  const { players, matches, numGroups } = tournament;
  const [modal, setModal] = useState(null);
  const stats = computeGroupStats(players, matches);

  const handleScore = (matchId, result) => {
    onUpdate({ ...tournament, matches: matches.map(m => m.id===matchId ? {...m, result} : m) });
    setModal(null);
  };

  const allDone = matches.every(m => m.result);

  const handleAdvance = () => {
    const ko = buildKOFromGroups(players, matches, numGroups);
    onUpdate({ ...tournament, phase: "knockout", koMatches: ko });
  };

  return (
    <div>
      {modal && <ScoreModal match={modal} players={players} onSave={r=>handleScore(modal.id,r)} onClose={()=>setModal(null)}/>}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Fase de Grupos</h2>
        {allDone && (
          <button onClick={handleAdvance} style={{ padding:"8px 16px", background:C.teal, border:"none", borderRadius:9, color:C.white, cursor:"pointer", fontSize:13, fontWeight:700 }}>
            Avanzar a Eliminatorias →
          </button>
        )}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(300px, 1fr))", gap:16 }}>
        {Array.from({length:numGroups}, (_, g) => {
          const gp = players.filter(p => p.group === g);
          const sorted = sortGroup(gp, stats);
          const gMatches = matches.filter(m => m.group === g);
          const gDone = gMatches.every(m => m.result);

          return (
            <div key={g} style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 2px 10px ${C.shadow}` }}>
              <div style={{ padding:"12px 16px", background:gDone ? C.tealXlt : C.teal, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontFamily:FONT_DISPLAY, fontWeight:700, fontSize:15, color:gDone ? C.teal : C.white }}>
                  Grupo {String.fromCharCode(65+g)}
                </span>
                {gDone && <span style={{ fontSize:11, color:C.tealMd, fontWeight:700 }}>✓ COMPLETO</span>}
              </div>

              {/* Standings */}
              <div style={{ padding:"10px 14px 6px" }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 28px 28px 28px 48px", fontSize:10, color:C.mutedLt, fontWeight:600, letterSpacing:.5, paddingBottom:6, borderBottom:`1px solid ${C.border}`, gap:4 }}>
                  <span>JUGADOR</span><span style={{textAlign:"center"}}>PJ</span><span style={{textAlign:"center"}}>G</span><span style={{textAlign:"center"}}>P</span><span style={{textAlign:"center"}}>SETS</span>
                </div>
                {sorted.map((p, rank) => (
                  <div key={p.id} style={{ display:"grid", gridTemplateColumns:"1fr 28px 28px 28px 48px", alignItems:"center", gap:4, padding:"7px 0", borderBottom:`1px solid ${C.border}33` }}>
                    <span style={{ fontSize:13, color: rank<2 ? C.teal : C.muted, fontWeight: rank<2 ? 600 : 400, display:"flex", alignItems:"center", gap:5 }}>
                      {rank<2 && <span style={{ width:5, height:5, borderRadius:"50%", background:C.teal, display:"inline-block", flexShrink:0 }}/>}
                      {p.name}
                    </span>
                    <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.wins+p.losses}</span>
                    <span style={{ textAlign:"center", fontSize:12, color:C.win, fontWeight:600 }}>{p.wins}</span>
                    <span style={{ textAlign:"center", fontSize:12, color:C.lose }}>{p.losses}</span>
                    <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.setsWon}-{p.setsLost}</span>
                  </div>
                ))}
              </div>

              {/* Matches */}
              <div style={{ padding:"6px 14px 12px" }}>
                <p style={{ fontSize:10, color:C.mutedLt, letterSpacing:.5, fontWeight:600, margin:"6px 0 6px" }}>PARTIDOS</p>
                {gMatches.map(m => {
                  const pp1 = players.find(p=>p.id===m.p1), pp2 = players.find(p=>p.id===m.p2);
                  const r = m.result;
                  return (
                    <div key={m.id} onClick={()=>setModal(m)} style={{
                      display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", gap:6,
                      padding:"8px 10px", borderRadius:8, marginBottom:4, cursor:"pointer",
                      background: r ? C.tealXlt : C.bg, border:`1px solid ${r ? C.teal+"22" : C.border}`,
                      transition:"all .15s",
                    }}>
                      <span style={{ fontSize:12, color: r?.winner===m.p1 ? C.teal : C.muted, fontWeight: r?.winner===m.p1 ? 700 : 400, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pp1?.name}</span>
                      <span style={{ fontSize:12, color:C.teal, fontWeight:700, minWidth:44, textAlign:"center" }}>
                        {r ? (r.walkover ? "W/O" : `${r.p1Sets}–${r.p2Sets}`) : "vs"}
                      </span>
                      <span style={{ fontSize:12, color: r?.winner===m.p2 ? C.teal : C.muted, fontWeight: r?.winner===m.p2 ? 700 : 400, textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pp2?.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── BRACKET VIEW ─────────────────────────────────────────────────────────────
function BracketCard({ match, players, onClick }) {
  const p1 = players.find(p=>p.id===match?.p1);
  const p2 = players.find(p=>p.id===match?.p2);
  const r = match?.result;
  const canClick = match?.p1 && match?.p2;

  return (
    <div onClick={()=>canClick && onClick(match)} style={{
      background:C.white, border:`1.5px solid ${r ? C.teal+"55" : C.border}`, borderRadius:10,
      minWidth:170, overflow:"hidden", cursor: canClick ? "pointer" : "default",
      boxShadow: r ? `0 2px 12px ${C.teal}22` : `0 1px 6px ${C.shadow}`,
      transition:"all .15s",
    }}>
      {[{pl:p1, score:r?.p1Sets, win:r?.winner===match?.p1}, {pl:p2, score:r?.p2Sets, win:r?.winner===match?.p2}].map((row,i) => (
        <div key={i} style={{
          display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 12px",
          background: row.win ? C.tealXlt : "transparent",
          borderTop: i===1 ? `1px solid ${C.border}` : "none"
        }}>
          <span style={{ fontSize:13, color: row.win ? C.teal : row.pl ? C.text : C.mutedLt, fontWeight: row.win ? 700 : 400 }}>
            {row.pl?.name || (match?.p1||match?.p2 ? "Por definir" : "–")}
          </span>
          {r && <span style={{ fontWeight:700, color: row.win ? C.teal : C.muted, fontSize:15 }}>{r.walkover ? (row.win?"W":"–") : row.score}</span>}
        </div>
      ))}
    </div>
  );
}

// ─── MANUAL DRAW MODAL ───────────────────────────────────────────────────────
// Permite asignar manualmente los cruces de la primera ronda KO
function ManualDrawModal({ koMatches, players, onSave, onClose }) {
  const firstPhase = koMatches.some(m => m.phase === "r16") ? "r16"
                   : koMatches.some(m => m.phase === "qf")  ? "qf"
                   : "sf";
  const firstRound = koMatches.filter(m => m.phase === firstPhase);
  const realIds = [...new Set(firstRound.flatMap(m => [m.p1, m.p2]).filter(Boolean))];

  // Estado local: array de pares [p1id, p2id] por slot
  const [pairs, setPairs] = useState(
    firstRound.map(m => ({ p1: m.p1 ?? "", p2: m.p2 ?? "" }))
  );

  // IDs ya usados en otros slots (para no repetir)
  const usedIds = (currentSlot, side) => {
    const used = new Set();
    pairs.forEach((p, i) => {
      if (i === currentSlot) return;
      if (p.p1) used.add(p.p1);
      if (p.p2) used.add(p.p2);
    });
    // También el otro lado del mismo slot
    const other = side === "p1" ? pairs[currentSlot].p2 : pairs[currentSlot].p1;
    if (other) used.add(other);
    return used;
  };

  const allAssigned = pairs.every(p => p.p1 && p.p2);
  // Verificar que no haya duplicados
  const allIds = pairs.flatMap(p => [p.p1, p.p2]).filter(Boolean);
  const noDuplicates = new Set(allIds).size === allIds.length;
  const canSave = allAssigned && noDuplicates;

  const handleSave = () => {
    if (!canSave) return;
    const newFirst = firstRound.map((m, i) => ({
      ...m, p1: pairs[i].p1, p2: pairs[i].p2, result: null,
    }));
    const rest = koMatches
      .filter(m => m.phase !== firstPhase)
      .map(m => ({ ...m, p1: null, p2: null, result: null }));
    onSave([...newFirst, ...rest]);
  };

  const phaseLabel = { r16: "16avos de Final", qf: "Cuartos de Final", sf: "Semifinales" };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(26,46,46,0.55)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
      <div style={{ background:C.white, borderRadius:16, padding:28, width:"100%", maxWidth:440, maxHeight:"90vh", overflowY:"auto", boxShadow:`0 20px 60px ${C.shadowMd}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <h3 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Asignación manual</h3>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:22 }}>×</button>
        </div>
        <p style={{ margin:"0 0 20px", color:C.muted, fontSize:12 }}>{phaseLabel[firstPhase]} · Asigná cada cruce manualmente</p>

        {pairs.map((pair, i) => {
          const usedP1 = usedIds(i, "p1");
          const usedP2 = usedIds(i, "p2");
          return (
            <div key={i} style={{ marginBottom:16, padding:"14px 16px", background:C.tealXlt, borderRadius:10, border:`1px solid ${C.teal}22` }}>
              <p style={{ margin:"0 0 10px", fontSize:11, color:C.teal, fontWeight:700, letterSpacing:.5 }}>
                CRUCE {i + 1}
              </p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 24px 1fr", alignItems:"center", gap:8 }}>
                <select
                  value={pair.p1}
                  onChange={e => setPairs(prev => prev.map((x,j) => j===i ? {...x, p1: e.target.value} : x))}
                  style={{ padding:"8px 10px", borderRadius:8, border:`1.5px solid ${pair.p1 ? C.teal : C.border}`, background:C.white, color: pair.p1 ? C.teal : C.muted, fontSize:13, fontWeight: pair.p1 ? 600 : 400, outline:"none" }}
                >
                  <option value="">— elegir —</option>
                  {realIds.map(id => {
                    const pl = players.find(p => p.id === id);
                    const disabled = usedP1.has(id);
                    return <option key={id} value={id} disabled={disabled}>{pl?.name}{disabled ? " ✗" : ""}</option>;
                  })}
                </select>
                <span style={{ textAlign:"center", color:C.mutedLt, fontSize:12, fontWeight:700 }}>vs</span>
                <select
                  value={pair.p2}
                  onChange={e => setPairs(prev => prev.map((x,j) => j===i ? {...x, p2: e.target.value} : x))}
                  style={{ padding:"8px 10px", borderRadius:8, border:`1.5px solid ${pair.p2 ? C.teal : C.border}`, background:C.white, color: pair.p2 ? C.teal : C.muted, fontSize:13, fontWeight: pair.p2 ? 600 : 400, outline:"none" }}
                >
                  <option value="">— elegir —</option>
                  {realIds.map(id => {
                    const pl = players.find(p => p.id === id);
                    const disabled = usedP2.has(id);
                    return <option key={id} value={id} disabled={disabled}>{pl?.name}{disabled ? " ✗" : ""}</option>;
                  })}
                </select>
              </div>
            </div>
          );
        })}

        {!noDuplicates && allAssigned && (
          <p style={{ color:C.lose, fontSize:12, margin:"0 0 12px", textAlign:"center" }}>⚠️ Hay jugadores repetidos en los cruces</p>
        )}

        <div style={{ display:"flex", gap:10, marginTop:8 }}>
          <button onClick={onClose} style={{ flex:1, padding:"11px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:9, color:C.muted, cursor:"pointer", fontSize:14 }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={!canSave} style={{
            flex:2, padding:"11px", background: canSave ? C.teal : C.border, border:"none",
            borderRadius:9, color: canSave ? C.white : C.muted, fontWeight:700,
            cursor: canSave ? "pointer" : "not-allowed", fontSize:14
          }}>
            Confirmar cruces →
          </button>
        </div>
      </div>
    </div>
  );
}

function KnockoutView({ tournament, onUpdate }) {
  const { players, koMatches } = tournament;
  const [modal, setModal] = useState(null);

  const handleScore = (matchId, result) => {
    const updated = propagateKO(koMatches, matchId, result);
    onUpdate({ ...tournament, koMatches: updated });
    setModal(null);
  };

  // El sorteo se puede hacer solo UNA vez; después se bloquea
  const alreadyShuffled = !!tournament.koShuffled;
  const [showManualDraw, setShowManualDraw] = useState(false);

  const handleManualSave = (newKoMatches) => {
    onUpdate({ ...tournament, koMatches: newKoMatches, koShuffled: true });
    setShowManualDraw(false);
  };

  const handleShuffle = () => {
    if (alreadyShuffled) return;
    // La primera fase puede ser r16, qf o sf según cantidad de jugadores
    const firstPhase = koMatches.some(m => m.phase === "r16") ? "r16"
                     : koMatches.some(m => m.phase === "qf")  ? "qf"
                     : "sf";
    const firstRound = koMatches.filter(m => m.phase === firstPhase);
    // Solo jugadores reales (nunca null/undefined)
    const realIds = firstRound.flatMap(m => [m.p1, m.p2]).filter(Boolean);
    if (realIds.length < 2) return;
    // Mezclar el pool completo y re-asignar en pares consecutivos
    const pool = shuffle(realIds);
    const newFirst = firstRound.map((m, i) => ({
      ...m,
      p1: pool[i * 2] ?? null,
      p2: pool[i * 2 + 1] ?? null,
      result: null,
    }));
    // Limpiar las fases siguientes (ya no tienen jugadores asignados)
    const rest = koMatches
      .filter(m => m.phase !== firstPhase)
      .map(m => ({ ...m, p1: null, p2: null, result: null }));
    onUpdate({ ...tournament, koMatches: [...newFirst, ...rest], koShuffled: true });
  };

  const r16    = koMatches.filter(m=>m.phase==="r16");
  const qf     = koMatches.filter(m=>m.phase==="qf");
  const sf     = koMatches.filter(m=>m.phase==="sf");
  const final  = koMatches.find(m=>m.phase==="final");
  const bronze = koMatches.find(m=>m.phase==="bronze");
  const champion  = final?.result?.winner;
  const champName = players.find(p=>p.id===champion)?.name;
  const hasR16 = r16.length > 0;
  const hasQF  = qf.length > 0;

  const col = (label, items) => (
    <div style={{ display:"flex", flexDirection:"column", gap:16, alignItems:"center" }}>
      <span style={{ fontSize:10, letterSpacing:1, color:C.mutedLt, fontWeight:700 }}>{label}</span>
      {items.map(m => m && <BracketCard key={m.id} match={m} players={players} onClick={setModal}/>)}
    </div>
  );

  // Calcular minWidth dinámicamente según columnas
  const numCols = (hasR16 ? 1 : 0) + (hasQF ? 1 : 0) + 1 + 1; // R16? QF? SF Final
  const minW = Math.max(500, numCols * 220);

  return (
    <div>
      {modal && <ScoreModal match={modal} players={players} onSave={r=>handleScore(modal.id,r)} onClose={()=>setModal(null)}/>}
      {showManualDraw && (
        <ManualDrawModal
          koMatches={koMatches}
          players={players}
          onSave={handleManualSave}
          onClose={() => setShowManualDraw(false)}
        />
      )}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Eliminación Directa</h2>
        {alreadyShuffled ? (
          <span style={{ fontSize:12, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:9, padding:"8px 14px", display:"flex", alignItems:"center", gap:6 }}>
            ✓ Cruces definidos
          </span>
        ) : (
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setShowManualDraw(true)} style={{ padding:"8px 16px", background:C.white, border:`1.5px solid ${C.teal}`, borderRadius:9, color:C.teal, cursor:"pointer", fontSize:13, fontWeight:600 }}>
              ✏️ Asignar manual
            </button>
            <button onClick={handleShuffle} style={{ padding:"8px 16px", background:C.tealLt, border:`1px solid ${C.teal}33`, borderRadius:9, color:C.teal, cursor:"pointer", fontSize:13, fontWeight:600 }}>
              🔀 Sortear cruces
            </button>
          </div>
        )}
      </div>

      {champName && (
        <div style={{ background:`linear-gradient(135deg, ${C.teal}, ${C.tealMd})`, borderRadius:12, padding:"16px 24px", marginBottom:24, display:"flex", alignItems:"center", gap:16 }}>
          <span style={{ fontSize:32 }}>🏆</span>
          <div>
            <p style={{ margin:0, color:"rgba(255,255,255,0.6)", fontSize:11, letterSpacing:1 }}>CAMPEÓN DEL TORNEO</p>
            <p style={{ margin:"2px 0 0", color:C.white, fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:22 }}>{champName}</p>
          </div>
        </div>
      )}

      <div style={{ overflowX:"auto", paddingBottom:16 }}>
        <div style={{ display:"flex", gap:32, alignItems:"center", minWidth:`${minW}px`, justifyContent:"center", padding:"8px 0" }}>

          {/* R16 — solo si hay más de 8 clasificados */}
          {hasR16 && <>
            {col("16avos DE FINAL", r16)}
            <div style={{ color:C.border, fontSize:20 }}>›</div>
          </>}

          {/* QF — solo si hay más de 4 clasificados */}
          {hasQF && <>
            {col("CUARTOS DE FINAL", qf)}
            <div style={{ color:C.border, fontSize:20 }}>›</div>
          </>}

          {/* SF — siempre presente */}
          {col("SEMIFINALES", sf)}
          <div style={{ color:C.border, fontSize:20 }}>›</div>

          {/* Final + Bronce */}
          <div style={{ display:"flex", flexDirection:"column", gap:16, alignItems:"center" }}>
            <span style={{ fontSize:10, letterSpacing:1, color:C.mutedLt, fontWeight:700 }}>FINAL</span>
            {final && <BracketCard match={final} players={players} onClick={setModal}/>}
            <span style={{ fontSize:10, letterSpacing:1, color:C.mutedLt, fontWeight:700, marginTop:8 }}>3° PUESTO</span>
            {bronze && <BracketCard match={bronze} players={players} onClick={setModal}/>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RANKING ──────────────────────────────────────────────────────────────────
function RankingView({ tournament }) {
  const { players, matches, koMatches = [] } = tournament;

  // ── 1. Stats acumuladas de TODOS los partidos (grupos + eliminatorias) ──────
  const stats = {};
  players.forEach(p => {
    stats[p.id] = { ...p, wins: 0, losses: 0, setsWon: 0, setsLost: 0, ptsWon: 0, ptsLost: 0 };
  });
  const allPlayed = [...(matches || []), ...koMatches].filter(m => m.result);
  allPlayed.forEach(m => {
    const r = m.result;
    if (!stats[m.p1] || !stats[m.p2]) return;
    if (r.walkover) {
      stats[r.winner].wins++;
      stats[r.loser].losses++;
    } else {
      stats[r.winner].wins++;
      stats[r.loser].losses++;
      stats[m.p1].setsWon  += r.p1Sets; stats[m.p1].setsLost += r.p2Sets;
      stats[m.p2].setsWon  += r.p2Sets; stats[m.p2].setsLost += r.p1Sets;
      stats[m.p1].ptsWon   += r.p1Pts;  stats[m.p1].ptsLost  += r.p2Pts;
      stats[m.p2].ptsWon   += r.p2Pts;  stats[m.p2].ptsLost  += r.p1Pts;
    }
  });

  // ── 2. Posiciones fijas de la fase KO (si existe) ──────────────────────────
  const finalMatch  = koMatches.find(m => m.phase === "final");
  const bronzeMatch = koMatches.find(m => m.phase === "bronze");
  const champion  = finalMatch?.result?.winner  ?? null;
  const finalist  = finalMatch?.result
    ? (finalMatch.result.winner === finalMatch.p1 ? finalMatch.p2 : finalMatch.p1)
    : null;
  const third  = bronzeMatch?.result?.winner  ?? null;
  const fourth = bronzeMatch?.result
    ? (bronzeMatch.result.winner === bronzeMatch.p1 ? bronzeMatch.p2 : bronzeMatch.p1)
    : null;

  // IDs con posición fija (del KO)
  const fixedPositions = [champion, finalist, third, fourth].filter(Boolean);

  // ── 3. Resto ordenado por rendimiento acumulado ────────────────────────────
  const rest = Object.values(stats)
    .filter(p => !fixedPositions.includes(p.id))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if ((b.setsWon - b.setsLost) !== (a.setsWon - a.setsLost))
        return (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost);
      return (b.ptsWon - b.ptsLost) - (a.ptsWon - a.ptsLost);
    });

  // ── 4. Lista final ordenada ────────────────────────────────────────────────
  const sorted = [
    ...[champion, finalist, third, fourth]
      .filter(Boolean)
      .map(id => stats[id]),
    ...rest,
  ];

  const medalIcon = (i) => {
    if (i === 0) return "🥇";
    if (i === 1) return "🥈";
    if (i === 2) return "🥉";
    return i + 1;
  };
  const medalColor = (i) => {
    if (i === 0) return "#d4a017";
    if (i === 1) return "#9e9e9e";
    if (i === 2) return "#a0714f";
    return C.mutedLt;
  };

  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Ranking General</h2>

      {champion && (
        <div style={{ background:`linear-gradient(135deg,${C.teal},${C.tealMd})`, borderRadius:12, padding:"14px 20px", marginBottom:20, display:"flex", gap:14, alignItems:"center" }}>
          <span style={{ fontSize:28 }}>🏆</span>
          <div>
            <p style={{ margin:0, color:"rgba(255,255,255,0.6)", fontSize:11, letterSpacing:1 }}>CAMPEÓN DEL TORNEO</p>
            <p style={{ margin:0, color:C.white, fontWeight:700, fontSize:18 }}>{players.find(p=>p.id===champion)?.name}</p>
          </div>
        </div>
      )}

      <div style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 2px 10px ${C.shadow}` }}>
        <div style={{ display:"grid", gridTemplateColumns:"40px 1fr 44px 44px 44px 60px 70px", padding:"10px 16px", fontSize:10, color:C.mutedLt, fontWeight:700, letterSpacing:.5, borderBottom:`1px solid ${C.border}`, gap:4 }}>
          <span>#</span><span>JUGADOR</span>
          <span style={{textAlign:"center"}}>PJ</span>
          <span style={{textAlign:"center"}}>G</span>
          <span style={{textAlign:"center"}}>P</span>
          <span style={{textAlign:"center"}}>SETS</span>
          <span style={{textAlign:"center"}}>PUNTOS</span>
        </div>
        {sorted.map((p, i) => p && (
          <div key={p.id} style={{
            display:"grid", gridTemplateColumns:"40px 1fr 44px 44px 44px 60px 70px",
            padding:"11px 16px", gap:4, alignItems:"center",
            background: i < 4 && fixedPositions.includes(p.id)
              ? (i === 0 ? "#fffbea" : i === 1 ? "#f8f8f8" : i === 2 ? "#fdf4ef" : C.bg)
              : i % 2 === 0 ? C.bg : C.white,
            borderBottom:`1px solid ${C.border}33`,
            borderLeft: i < 4 && fixedPositions.includes(p.id)
              ? `3px solid ${medalColor(i)}`
              : "3px solid transparent",
          }}>
            <span style={{ fontSize: i < 3 ? 18 : 13, color: medalColor(i), fontWeight:700, textAlign:"center" }}>
              {medalIcon(i)}
            </span>
            <span style={{ fontSize:13, color:C.text, fontWeight: i < 4 ? 700 : 400 }}>{p.name}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.wins + p.losses}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.win, fontWeight:600 }}>{p.wins}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.lose }}>{p.losses}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.setsWon}-{p.setsLost}</span>
            <span style={{ textAlign:"center", fontSize:12, color:C.muted }}>{p.ptsWon}-{p.ptsLost}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
function HistoryView({ tournament }) {
  const { players, matches, koMatches } = tournament;
  const allMatches = [...(matches||[]), ...(koMatches||[])].filter(m=>m.result).reverse();
  const phaseLabel = { group:"Grupos", qf:"Cuartos", sf:"Semifinal", final:"Final", bronze:"3° Puesto" };

  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Historial de partidos</h2>
      {allMatches.length === 0 && <p style={{ color:C.muted, textAlign:"center", paddingTop:40 }}>Sin partidos jugados aún.</p>}
      {allMatches.map(m => {
        const p1 = players.find(p=>p.id===m.p1), p2 = players.find(p=>p.id===m.p2);
        const r = m.result;
        return (
          <div key={m.id} style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 18px", marginBottom:10, boxShadow:`0 1px 6px ${C.shadow}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
              <span style={{ fontSize:11, color:C.muted, fontWeight:600 }}>
                {phaseLabel[m.phase]}{m.phase==="group" ? ` · Grupo ${String.fromCharCode(65+m.group)}` : ""}
              </span>
              {r.walkover && <span style={{ fontSize:11, color:C.lose, fontWeight:700, background:C.loseBg, padding:"2px 8px", borderRadius:10 }}>WALK OVER</span>}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", gap:8 }}>
              <span style={{ color: r.winner===m.p1 ? C.teal : C.muted, fontWeight: r.winner===m.p1 ? 700 : 400, fontSize:14 }}>{p1?.name}</span>
              <span style={{ color:C.teal, fontWeight:800, fontSize:22, minWidth:52, textAlign:"center" }}>
                {r.walkover ? "W/O" : `${r.p1Sets}–${r.p2Sets}`}
              </span>
              <span style={{ color: r.winner===m.p2 ? C.teal : C.muted, fontWeight: r.winner===m.p2 ? 700 : 400, fontSize:14, textAlign:"right" }}>{p2?.name}</span>
            </div>
            {!r.walkover && r.rawSets && (
              <div style={{ display:"flex", gap:6, justifyContent:"center", marginTop:8, flexWrap:"wrap" }}>
                {r.rawSets.filter(s=>s.p1!==""&&s.p2!=="").map((s,i) => (
                  <span key={i} style={{ fontSize:11, color:C.muted, background:C.bg, padding:"2px 8px", borderRadius:6, border:`1px solid ${C.border}` }}>
                    {s.p1}–{s.p2}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SETUP VIEW ───────────────────────────────────────────────────────────────
function SetupView({ tournament, onUpdate }) {
  const { players, numGroups } = tournament;
  // localNames keyed by player id — sobrevive al shuffle
  const [localNames, setLocalNames] = useState(() => {
    const m = {};
    players.forEach(p => { m[p.id] = p.name; });
    return m;
  });

  // El sorteo se bloquea después del primer uso
  const alreadyShuffled = !!tournament.setupShuffled;

  const handleShuffle = () => {
    if (alreadyShuffled) return;
    // Mezclar los ids de jugadores y reasignar grupos
    const shuffledIds = shuffle(players.map(p => p.id));
    const perGroup = Math.ceil(players.length / numGroups);
    const shuffledPlayers = shuffledIds.map((id, i) => {
      const p = players.find(x => x.id === id);
      return { ...p, group: Math.floor(i / perGroup) };
    });
    onUpdate({ ...tournament, players: shuffledPlayers, setupShuffled: true });
  };

  const handleStart = () => {
    // Aplicar nombres editados (por id) antes de iniciar
    const named = players.map(p => ({ ...p, name: localNames[p.id] || p.name }));
    const newMatches = generateGroupMatches(named);
    onUpdate({ ...tournament, phase: "groups", players: named, matches: newMatches });
  };

  const handleNameChange = (pid, val) => {
    setLocalNames(prev => ({ ...prev, [pid]: val }));
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontFamily:FONT_DISPLAY, color:C.teal, fontSize:18 }}>Configuración del torneo</h2>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {alreadyShuffled ? (
            <span style={{ fontSize:12, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:9, padding:"8px 14px" }}>
              ✓ Grupos sorteados
            </span>
          ) : (
            <button onClick={handleShuffle} style={{ padding:"8px 16px", background:C.tealLt, border:`1px solid ${C.teal}33`, borderRadius:9, color:C.teal, cursor:"pointer", fontSize:13, fontWeight:600 }}>
              🔀 Sortear grupos
            </button>
          )}
          <button onClick={handleStart} style={{ padding:"8px 20px", background:C.teal, border:"none", borderRadius:9, color:C.white, cursor:"pointer", fontSize:13, fontWeight:700 }}>
            Iniciar torneo →
          </button>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px,1fr))", gap:16 }}>
        {Array.from({length:numGroups}, (_,g) => {
          const gp = players.filter(p=>p.group===g);
          return (
            <div key={g} style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 2px 8px ${C.shadow}` }}>
              <div style={{ padding:"10px 14px", background:C.teal }}>
                <span style={{ color:C.white, fontWeight:700, fontFamily:FONT_DISPLAY }}>Grupo {String.fromCharCode(65+g)}</span>
              </div>
              <div style={{ padding:"10px 14px" }}>
                {gp.map((p, pi) => (
                  <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:`1px solid ${C.border}33` }}>
                    <span style={{ color:C.mutedLt, fontSize:11, width:16 }}>{pi+1}</span>
                    <input
                      value={localNames[p.id] ?? p.name}
                      onChange={e => handleNameChange(p.id, e.target.value)}
                      style={{ flex:1, background:"none", border:"none", outline:"none", color:C.text, fontSize:13 }}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── TOURNAMENT DETAIL ────────────────────────────────────────────────────────
function TournamentDetail({ tournament, onUpdate, onBack, onLogout, userEmail }) {
  const tabs = tournament.phase === "setup"
    ? [{ id:"setup", label:"Grupos" }]
    : tournament.phase === "roundrobin"
    ? [{ id:"roundrobin", label:"Partidos" }, { id:"ranking", label:"Ranking" }, { id:"history", label:"Historial" }]
    : tournament.phase === "groups"
    ? [{ id:"groups", label:"Grupos" }, { id:"ranking", label:"Ranking" }, { id:"history", label:"Historial" }]
    : [{ id:"bracket", label:"Bracket" }, { id:"ranking", label:"Ranking" }, { id:"history", label:"Historial" }];

  const defaultTab = tabs[0].id;
  const [tab, setTab] = useState(defaultTab);

  useEffect(() => { setTab(tabs[0].id); }, [tournament.phase]);

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:FONT_BODY }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <Watermark/>

      {/* Header */}
      <header style={{ background:C.teal, padding:"20px 24px 0" }}>
        <div style={{ maxWidth:900, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <button onClick={onBack} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.6)", cursor:"pointer", fontSize:13, padding:0, display:"flex", alignItems:"center", gap:6 }}>
              ← Volver a torneos
            </button>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:12, color:"rgba(255,255,255,0.5)" }}>{userEmail}</span>
              <button onClick={onLogout} style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", borderRadius:8, color:"rgba(255,255,255,0.7)", cursor:"pointer", fontSize:12, padding:"5px 12px" }}>
                Salir
              </button>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:16 }}>
            <Logo size={44}/>
            <div>
              <p style={{ margin:0, color:"rgba(255,255,255,0.55)", fontSize:11, letterSpacing:1 }}>TORNEO</p>
              <h1 style={{ margin:0, color:C.white, fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:22 }}>{tournament.name}</h1>
            </div>
          </div>
          <nav style={{ display:"flex", gap:2 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={()=>setTab(t.id)} style={{
                padding:"9px 20px", background: tab===t.id ? C.white : "transparent", border:"none",
                borderRadius:"8px 8px 0 0", color: tab===t.id ? C.teal : "rgba(255,255,255,0.65)",
                cursor:"pointer", fontWeight: tab===t.id ? 700 : 500, fontSize:14, transition:"all .15s"
              }}>{t.label}</button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth:900, margin:"0 auto", padding:"28px 24px" }}>
        {tab==="setup"      && <SetupView       tournament={tournament} onUpdate={onUpdate}/>}
        {tab==="groups"     && <GroupPhaseView  tournament={tournament} onUpdate={onUpdate}/>}
        {tab==="roundrobin" && <RoundRobinView  tournament={tournament} onUpdate={onUpdate}/>}
        {tab==="bracket"    && <KnockoutView    tournament={tournament} onUpdate={onUpdate}/>}
        {tab==="ranking"    && <RankingView     tournament={tournament}/>}
        {tab==="history"    && <HistoryView     tournament={tournament}/>}
      </main>
    </div>
  );
}



// ─── WATERMARK ────────────────────────────────────────────────────────────────
function Watermark() {
  return (
    <div style={{
      position:"fixed", bottom:14, right:16, zIndex:999,
      pointerEvents:"none", userSelect:"none",
      display:"flex", alignItems:"center", gap:6,
      opacity:0.35,
    }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke={C.teal} strokeWidth="1.5"/>
        <text x="8" y="11.5" textAnchor="middle" fill={C.teal} fontSize="8" fontWeight="700" fontFamily="serif">M</text>
      </svg>
      <span style={{ fontSize:11, color:C.teal, fontFamily:FONT_DISPLAY, fontWeight:600, letterSpacing:.5 }}>
        Melissa Berdeja
      </span>
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      setError("Email o contraseña incorrectos");
      setLoading(false);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter") handleLogin(); };

  return (
    <div style={{ minHeight:"100vh", background:C.teal, display:"flex", alignItems:"center", justifyContent:"center", padding:24, fontFamily:FONT_BODY }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <div style={{ background:C.white, borderRadius:20, padding:40, width:"100%", maxWidth:380, boxShadow:`0 24px 64px rgba(0,0,0,0.25)` }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <Logo size={64}/>
          <h1 style={{ margin:"16px 0 4px", fontFamily:FONT_DISPLAY, color:C.teal, fontSize:22, fontWeight:800 }}>Tenis de Mesa</h1>
          <p style={{ margin:0, color:C.muted, fontSize:13 }}>Asociación Departamental · Santa Cruz</p>
        </div>

        <label style={{ display:"block", fontSize:13, color:C.teal, fontWeight:600, marginBottom:6 }}>Email</label>
        <input
          type="email" value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={handleKey}
          placeholder="tu@email.com"
          style={{ width:"100%", padding:"11px 14px", borderRadius:9, border:`1.5px solid ${C.border}`, fontSize:14, color:C.text, marginBottom:16, boxSizing:"border-box", outline:"none" }}
        />

        <label style={{ display:"block", fontSize:13, color:C.teal, fontWeight:600, marginBottom:6 }}>Contraseña</label>
        <input
          type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={handleKey}
          placeholder="••••••••"
          style={{ width:"100%", padding:"11px 14px", borderRadius:9, border:`1.5px solid ${C.border}`, fontSize:14, color:C.text, marginBottom: error ? 10 : 20, boxSizing:"border-box", outline:"none" }}
        />

        {error && (
          <p style={{ color:C.lose, fontSize:13, margin:"0 0 16px", textAlign:"center" }}>⚠️ {error}</p>
        )}

        <button onClick={handleLogin} disabled={loading || !email || !password} style={{
          width:"100%", padding:"13px", background: email && password ? C.teal : C.border,
          border:"none", borderRadius:10, color: email && password ? C.white : C.muted,
          fontWeight:700, fontSize:15, cursor: email && password ? "pointer" : "not-allowed",
          fontFamily:FONT_DISPLAY
        }}>
          {loading ? "Ingresando..." : "Ingresar →"}
        </button>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = cargando, null = no logueado
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  // Auth state listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u ?? null));
    return () => unsub();
  }, []);

  // Firestore listener — solo cuando está logueado
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    const unsub = onSnapshot(collection(db, "tournaments"), (snap) => {
      const data = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setTournaments(data);
      setLoading(false);
    }, (err) => {
      console.error("Firestore error:", err);
      setLoading(false);
    });
    return () => unsub();
  }, [user]);

  const handleCreate = async (t) => {
    await setDoc(doc(db, "tournaments", t.id), { ...t, createdAt: Date.now() });
    setOpenId(t.id);
  };

  const handleUpdate = async (updated) => {
    await setDoc(doc(db, "tournaments", updated.id), updated);
  };

  const handleDelete = async (id) => {
    if (confirm("¿Eliminar este torneo?")) {
      await deleteDoc(doc(db, "tournaments", id));
      if (openId === id) setOpenId(null);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setOpenId(null);
    setTournaments([]);
  };

  // Pantalla de carga inicial (verificando auth)
  if (user === undefined) return (
    <div style={{ minHeight:"100vh", background:C.teal, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:16, fontFamily:"Inter, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700;800&family=Inter:wght@400;500&display=swap" rel="stylesheet"/>
      <Logo size={56}/>
      <p style={{ color:"rgba(255,255,255,0.7)", fontSize:14 }}>Cargando...</p>
    </div>
  );

  // No logueado → mostrar login
  if (!user) return <LoginScreen />;

  // Cargando torneos
  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#f5f7f6", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:16, fontFamily:"Inter, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700;800&family=Inter:wght@400;500&display=swap" rel="stylesheet"/>
      <Logo size={56}/>
      <p style={{ color:"#6b8f8e", fontSize:14 }}>Conectando...</p>
    </div>
  );

  const open = openId ? tournaments.find(t => t.id === openId) : null;

  if (open) {
    return <TournamentDetail
      tournament={open}
      onUpdate={handleUpdate}
      onBack={() => setOpenId(null)}
      onLogout={handleLogout}
      userEmail={user.email}
    />;
  }

  return <TournamentHome
    tournaments={tournaments}
    onCreate={handleCreate}
    onOpen={setOpenId}
    onDelete={handleDelete}
    onLogout={handleLogout}
    userEmail={user.email}
  />;
}
