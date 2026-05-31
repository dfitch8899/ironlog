import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { dbRead, dbWrite, dbSubscribe, isConfigured } from './firebase.js'

// ── constants ─────────────────────────────────────────────────────────────
const SPLIT_DAYS = ['Push', 'Pull', 'Legs', 'Forearms/Abs', 'Upper', 'Lower']
const COLORS = {
  Push: '#ef4444', Pull: '#3b82f6', Legs: '#22c55e',
  'Forearms/Abs': '#f59e0b', Upper: '#a855f7', Lower: '#06b6d4',
}
const GYM_CUTOVER = '2026-05-31'                 // first day at Ping (inclusive)
const GYMS = ['Planet Fitness', 'Ping']
const GYM_META = {
  'Planet Fitness': { short: 'PF',   color: '#a855f7' },
  'Ping':           { short: 'PING', color: '#14b8a6' },
}
const SEED = [
  {
    id: 1747180800004, date: '2025-05-14', day: 'Forearms/Abs', gym: 'Planet Fitness',
    lifts: [
      { exercise: 'Shoulder Press',            sets: [{ weight: 185,  reps: 5  }, { weight: 185, reps: 5  }] },
      { exercise: 'Forearm Curls (Bilateral)', sets: [{ weight: 72.5, reps: 12 }, { weight: 80,  reps: 10 }] },
      { exercise: 'Unilateral Forearm Curls',  sets: [{ weight: 35,   reps: 10 }] },
      { exercise: 'Ab Crunch',                 sets: [{ weight: 115,  reps: 12 }, { weight: 115, reps: 12 }] },
      { exercise: 'Reverse Wrist Curls',       sets: [{ weight: 20,   reps: 10 }, { weight: 20,  reps: 10 }] },
      { exercise: 'Leg Raise',                 sets: [{ weight: 0,    reps: 20 }, { weight: 0,   reps: 20 }] },
    ],
  },
  {
    id: 1747094400003, date: '2025-05-13', day: 'Legs', gym: 'Planet Fitness',
    lifts: [
      { exercise: 'Leg Press',               sets: [{ weight: 390, reps: 9  }, { weight: 390, reps: 9  }] },
      { exercise: 'Calf Extension',          sets: [{ weight: 390, reps: 10 }] },
      { exercise: 'Leg Extension',           sets: [{ weight: 285, reps: 10 }, { weight: 295, reps: 6  }] },
      { exercise: 'Single Leg Leg Extension',sets: [{ weight: 130, reps: 8  }] },
      { exercise: 'Lying Leg Curl',          sets: [{ weight: 170, reps: 8  }, { weight: 170, reps: 7  }] },
      { exercise: 'Cable Crunch',            sets: [{ weight: 105, reps: 12 }, { weight: 105, reps: 12 }] },
    ],
  },
  {
    id: 1747008000002, date: '2025-05-12', day: 'Pull', gym: 'Planet Fitness',
    lifts: [
      { exercise: 'Preacher Curls',     sets: [{ weight: 190, reps: 7  }, { weight: 190, reps: 7  }] },
      { exercise: 'Smith Rows',         sets: [{ weight: 145, reps: 8  }, { weight: 145, reps: 8  }] },
      { exercise: 'Recline Curl',       sets: [{ weight: 35,  reps: 10 }, { weight: 40,  reps: 6  }] },
      { exercise: 'Cable Lat Pulldown', sets: [{ weight: 90,  reps: 8  }, { weight: 90,  reps: 8  }] },
      { exercise: 'Bayesian Curl',      sets: [{ weight: 35,  reps: 8  }] },
      { exercise: 'Kelsos',             sets: [{ weight: 205, reps: 10 }, { weight: 205, reps: 10 }] },
    ],
  },
  {
    id: 1746921600001, date: '2025-05-11', day: 'Push', gym: 'Planet Fitness',
    lifts: [
      { exercise: 'Pec Deck',         sets: [{ weight: 220, reps: 7  }, { weight: 220, reps: 7  }] },
      { exercise: 'Rear Delt Flies',  sets: [{ weight: 175, reps: 8  }, { weight: 175, reps: 7  }] },
      { exercise: 'Tricep Extension', sets: [{ weight: 35,  reps: 10 }, { weight: 38,  reps: 8  }] },
      { exercise: 'Lat Raise',        sets: [{ weight: 28,  reps: 8  }, { weight: 28,  reps: 8  }] },
      { exercise: 'Y Raise',          sets: [{ weight: 28,  reps: 9  }, { weight: 28,  reps: 9  }] },
      { exercise: 'JM Press',         sets: [{ weight: 68,  reps: 10 }, { weight: 73,  reps: 10 }] },
    ],
  },
]

// ── helpers ───────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split('T')[0]
const fmt   = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtF  = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const dc    = o => JSON.parse(JSON.stringify(o))
const sortS = arr => [...arr].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
const gymForDate = d => (d >= GYM_CUTOVER ? 'Ping' : 'Planet Fitness')  // ISO string compare
const gymOf = s => s.gym || gymForDate(s.date)                          // backfills legacy records
const liftVolume = l => l.sets.reduce((a, x) => a + x.weight * x.reps, 0)
const liftMaxWeight = l => Math.max(...l.sets.map(x => x.weight))
const bestSet = l => l.sets.reduce(
  (best, s) => (s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps)) ? s : best,
  { weight: 0, reps: 0 }
)
const eqEx = (a, b) => a.toLowerCase().trim() === b.toLowerCase().trim()
const vibrate = (ms = 15) => navigator.vibrate?.(ms)
const fmtW = w => w === 0 ? 'BW' : w  // bodyweight display

// Streak: count consecutive prior days with at least one session, ending today or yesterday
function calcStreak(sessions) {
  if (!sessions.length) return 0
  const dates = new Set(sessions.map(s => s.date))
  let streak = 0
  const d = new Date()
  const todayHas = dates.has(d.toISOString().split('T')[0])
  if (!todayHas) d.setDate(d.getDate() - 1)
  while (dates.has(d.toISOString().split('T')[0])) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

// Rule-based plateau / improvement detector across the last N sessions of an exercise.
// progressData is the per-session array already computed in the Progress view (oldest → newest).
function analyzeTrend(data) {
  if (!data || data.length < 3) {
    return { label: 'NEW', color: '#888', detail: `${data?.length || 0} session${data?.length === 1 ? '' : 's'} — log 3+ to see trend` }
  }
  const recent = data.slice(-Math.min(5, data.length))
  const firstMax = recent[0].maxWeight
  const lastMax  = recent[recent.length - 1].maxWeight
  const firstVol = recent[0].volume
  const lastVol  = recent[recent.length - 1].volume
  const wDelta = +(lastMax - firstMax).toFixed(1)
  const vDelta = ((lastVol - firstVol) / Math.max(firstVol, 1)) * 100
  if (wDelta > 0 || vDelta >= 5) {
    const wStr = wDelta > 0 ? `+${wDelta}lb max · ` : ''
    return { label: 'IMPROVING', color: '#22c55e', detail: `${wStr}${vDelta >= 0 ? '+' : ''}${vDelta.toFixed(0)}% volume over last ${recent.length}` }
  }
  if (wDelta < 0 || vDelta <= -5) {
    const wStr = wDelta < 0 ? `${wDelta}lb max · ` : ''
    return { label: 'REGRESSING', color: '#ef4444', detail: `${wStr}${vDelta.toFixed(0)}% volume over last ${recent.length}` }
  }
  return { label: 'PLATEAU', color: '#f59e0b', detail: `No max-weight or volume change over last ${recent.length} sessions` }
}

// ── icons ────────────────────────────────────────────────────────────────
const Icon = ({ d, size = 24, w = 2.25 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
)
const IconPlus     = p => <Icon {...p} d={<><path d="M12 5v14" /><path d="M5 12h14" /></>} />
const IconList     = p => <Icon {...p} d={<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h11" /></>} />
const IconTrending = p => <Icon {...p} d={<><polyline points="3 17 9 11 13 15 21 7" /><polyline points="14 7 21 7 21 14" /></>} />
const IconBars     = p => <Icon {...p} d={<><line x1="6" y1="20" x2="6" y2="13" /><line x1="12" y1="20" x2="12" y2="8" /><line x1="18" y1="20" x2="18" y2="4" /></>} />
const IconArrowUp  = p => <Icon {...p} d={<><line x1="7" y1="17" x2="17" y2="7" /><polyline points="9 7 17 7 17 15" /></>} />
const IconArrowDn  = p => <Icon {...p} d={<><line x1="7" y1="7" x2="17" y2="17" /><polyline points="17 9 17 17 9 17" /></>} />
const IconDash     = p => <Icon {...p} d={<line x1="6" y1="12" x2="18" y2="12" />} />
const IconSpark    = p => <Icon {...p} d={<polygon points="12 3 14 10 21 12 14 14 12 21 10 14 3 12 10 10" />} />

// ── shared input style ──────────────────────────────────────────────────
const IS = {
  width: '100%', background: '#0d0d0d', border: '1px solid #222', color: '#e0e0e0',
  padding: '13px 14px', fontSize: 16, borderRadius: 10, marginBottom: 10,
  fontFamily: "'DM Mono', monospace",
}

// ── LiftBuilder ───────────────────────────────────────────────────────────
function LiftBuilder({ lift, color, day, exerciseHistory, dayExercises = [], lastLiftFor, onConfirm, onCancel, confirmLabel = 'CONFIRM ✓' }) {
  const [name, setName] = useState(lift?.exercise || '')
  const [sets, setSets] = useState(lift?.sets?.length ? dc(lift.sets) : [{ weight: '', reps: '' }])
  const wRefs = useRef([])
  const rRefs = useRef([])

  const prev = useMemo(() => name.trim() ? lastLiftFor(name) : null, [name, lastLiftFor])

  useEffect(() => {
    if (!prev || lift) return
    setSets(curr => {
      if (curr.every(s => s.weight === '')) {
        const lastW = prev.lift.sets[0].weight
        return curr.map(s => ({ ...s, weight: String(lastW) }))
      }
      return curr
    })
    // eslint-disable-next-line
  }, [prev?.session.id])

  const addSet = () => {
    const lastW = sets[sets.length - 1]?.weight || ''
    setSets(s => [...s, { weight: lastW, reps: '' }])
    setTimeout(() => rRefs.current[sets.length]?.focus(), 80)
  }
  const del = i => setSets(s => s.filter((_, j) => j !== i))
  const upd = (i, f, v) => setSets(s => s.map((x, j) => j === i ? { ...x, [f]: v } : x))
  const go = () => {
    if (!name.trim()) return alert('Enter exercise name')
    const filled = sets.filter(s => s.reps !== '' && s.weight !== '' && +s.reps > 0 && +s.weight >= 0)
    if (!filled.length) return alert('Add at least one complete set')
    onConfirm({ exercise: name.trim(), sets: filled.map(s => ({ weight: +s.weight, reps: +s.reps })) })
  }

  return (
    <div className="card-elev" style={{ background: '#0f0f0f', border: `1.5px solid ${color}55`, borderRadius: 16, padding: '20px 16px', position: 'relative' }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color, marginBottom: 14, fontWeight: 600 }}>LIFT</div>

      {dayExercises.length > 0 && (
        <select
          value=""
          onChange={e => { if (e.target.value) setName(e.target.value) }}
          style={{ ...IS, color: color, borderColor: color + '55' }}
        >
          <option value="" style={{ color: '#555' }}>— Quick pick · {day} —</option>
          {dayExercises.map(e => <option key={e} value={e} style={{ color: '#e0e0e0' }}>{e}</option>)}
        </select>
      )}

      {exerciseHistory.length > 0 && (
        <select
          value=""
          onChange={e => { if (e.target.value) setName(e.target.value) }}
          style={{ ...IS, color: '#888' }}
        >
          <option value="" style={{ color: '#555' }}>— All exercises —</option>
          {exerciseHistory.map(e => <option key={e} value={e} style={{ color: '#e0e0e0' }}>{e}</option>)}
        </select>
      )}

      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Or type new exercise name"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        list="exercise-history-datalist"
        style={IS}
      />
      <datalist id="exercise-history-datalist">
        {exerciseHistory.map(e => <option key={e} value={e} />)}
      </datalist>

      {prev && (
        <div style={{ background: '#0a0a0a', border: `1px solid ${color}22`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: '#9a9a9a', marginBottom: 8, fontWeight: 600 }}>
            LAST TIME · {fmt(prev.session.date)} · {prev.session.day}
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {prev.lift.sets.map((s, j) => (
              <span key={j} style={{ background: color + '18', border: `1px solid ${color}33`, borderRadius: 6, padding: '5px 11px', fontSize: 13, color }}>
                S{j + 1}: {fmtW(s.weight)}×{s.reps}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 1fr auto', gap: 6, marginBottom: 8 }}>
        <div />
        <div style={{ fontSize: 11, color: '#888', textAlign: 'center', letterSpacing: 1, fontWeight: 600 }}>WEIGHT (lbs)</div>
        <div style={{ fontSize: 11, color: '#888', textAlign: 'center', letterSpacing: 1, fontWeight: 600 }}>REPS</div>
        <div />
      </div>

      {sets.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 1fr auto', gap: 6, marginBottom: 7, alignItems: 'center' }}>
          <div style={{ background: color + '20', color, fontSize: 11, height: 44, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${color}33`, letterSpacing: 1 }}>S{i + 1}</div>
          <input
            ref={el => wRefs.current[i] = el}
            inputMode="decimal"
            type="number"
            value={s.weight}
            onChange={e => upd(i, 'weight', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && rRefs.current[i]?.focus()}
            placeholder="lbs"
            style={{ ...IS, margin: 0, textAlign: 'center' }}
          />
          <input
            ref={el => rRefs.current[i] = el}
            inputMode="numeric"
            type="number"
            value={s.reps}
            onChange={e => upd(i, 'reps', e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { i === sets.length - 1 ? addSet() : wRefs.current[i + 1]?.focus() } }}
            placeholder="reps"
            style={{ ...IS, margin: 0, textAlign: 'center' }}
          />
          {sets.length > 1
            ? <button onClick={() => del(i)} style={{ background: '#1e1e1e', border: 'none', color: '#555', width: 44, height: 44, borderRadius: 9, cursor: 'pointer', fontSize: 18 }}>×</button>
            : <div style={{ width: 44 }} />}
        </div>
      ))}

      <button onClick={addSet} style={{ width: '100%', background: 'none', border: '1px dashed #2a2a2a', color: '#7a7a7a', padding: '11px', borderRadius: 10, fontSize: 12, letterSpacing: 2, cursor: 'pointer', marginBottom: 14, marginTop: 4, fontFamily: "'DM Mono', monospace" }}>+ ADD SET</button>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, background: 'none', border: '1px solid #222', color: '#555', padding: '14px', borderRadius: 10, fontSize: 13, cursor: 'pointer', fontFamily: "'DM Mono', monospace" }}>CANCEL</button>
        <button onClick={go} style={{ flex: 2, background: color, border: 'none', color: '#000', padding: '14px', borderRadius: 10, fontSize: 13, letterSpacing: 2, cursor: 'pointer', fontWeight: 700, fontFamily: "'DM Mono', monospace" }}>{confirmLabel}</button>
      </div>
    </div>
  )
}

// ── SessionEditor ─────────────────────────────────────────────────────────
function SessionEditor({ session, exerciseHistory, exercisesByDay, lastLiftFor, onSave, onClose }) {
  const [date, setDate]   = useState(session.date)
  const [day, setDay]     = useState(session.day)
  const [gym, setGym]     = useState(gymOf(session))
  const [lifts, setLifts] = useState(dc(session.lifts))
  const [editIdx, setEditIdx]     = useState(null)
  const [addingNew, setAddingNew] = useState(false)
  const color = COLORS[day]

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#090909', zIndex: 100, overflowY: 'auto', maxWidth: 480, margin: '0 auto', fontFamily: "'DM Mono', monospace", paddingBottom: 120 }}>
      <div style={{ padding: '44px 16px 16px', borderBottom: '1px solid #161616', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', fontSize: 26, cursor: 'pointer' }}>‹</button>
        <div>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 28, letterSpacing: 4, color: '#fff', lineHeight: 1 }}>EDIT SESSION</div>
          <div style={{ fontSize: 10, color: '#666', letterSpacing: 2, marginTop: 2 }}>{fmtF(session.date)} — {session.day}</div>
        </div>
      </div>
      <div style={{ padding: '16px' }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...IS, color: '#888', marginBottom: 12 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          {GYMS.map(g => {
            const gc = GYM_META[g].color
            return (
              <button key={g} onClick={() => setGym(g)} style={{ background: gym === g ? gc + '22' : '#0e0e0e', border: `1.5px solid ${gym === g ? gc + 'aa' : '#1e1e1e'}`, color: gym === g ? gc : '#7a7a7a', padding: '13px 6px', borderRadius: 11, fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", boxShadow: gym === g ? `0 0 18px ${gc}33, inset 0 1px 0 ${gc}22` : 'inset 0 1px 0 rgba(255,255,255,0.02)' }}>{g}</button>
            )
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 20 }}>
          {SPLIT_DAYS.map(d => (
            <button key={d} onClick={() => setDay(d)} style={{ background: day === d ? COLORS[d] + '22' : '#0e0e0e', border: `1.5px solid ${day === d ? COLORS[d] + 'aa' : '#1e1e1e'}`, color: day === d ? COLORS[d] : '#7a7a7a', padding: '15px 6px', borderRadius: 11, fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", boxShadow: day === d ? `0 0 18px ${COLORS[d]}33, inset 0 1px 0 ${COLORS[d]}22` : 'inset 0 1px 0 rgba(255,255,255,0.02)' }}>{d}</button>
          ))}
        </div>
        <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 10 }}>LIFTS</div>
        {lifts.map((l, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {editIdx === i
              ? <LiftBuilder lift={l} color={color} day={day} exerciseHistory={exerciseHistory} dayExercises={exercisesByDay?.[day] || []} lastLiftFor={lastLiftFor} confirmLabel="SAVE LIFT ✓"
                  onConfirm={u => { setLifts(p => p.map((x, j) => j === i ? u : x)); setEditIdx(null) }}
                  onCancel={() => setEditIdx(null)} />
              : <div className="card" style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: '#ccc' }}>{l.exercise}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setEditIdx(i)} style={{ background: '#1e1e1e', border: 'none', color: '#888', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Mono', monospace" }}>EDIT</button>
                      <button onClick={() => setLifts(p => p.filter((_, j) => j !== i))} style={{ background: '#1e1e1e', border: 'none', color: '#555', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Mono', monospace" }}>✕</button>
                    </div>
                  </div>
                  <div style={{ padding: '0 14px 12px', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {l.sets.map((s, j) => <span key={j} style={{ background: color + '18', border: `1px solid ${color}33`, borderRadius: 6, padding: '5px 11px', fontSize: 13, color }}>S{j + 1}:{fmtW(s.weight)}×{s.reps}</span>)}
                  </div>
                </div>}
          </div>
        ))}
        {addingNew
          ? <LiftBuilder lift={null} color={color} day={day} exerciseHistory={exerciseHistory} dayExercises={exercisesByDay?.[day] || []} lastLiftFor={lastLiftFor} confirmLabel="ADD LIFT ✓"
              onConfirm={u => { setLifts(p => [...p, u]); setAddingNew(false) }}
              onCancel={() => setAddingNew(false)} />
          : <button onClick={() => setAddingNew(true)} style={{ width: '100%', background: '#111', border: `1.5px dashed ${color}55`, color, padding: '16px', borderRadius: 12, fontSize: 13, letterSpacing: 2, cursor: 'pointer', marginBottom: 14, fontFamily: "'DM Mono', monospace" }}>+ ADD LIFT</button>}
      </div>
      {!addingNew && editIdx === null && (
        <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)', background: '#0d0d0d', borderTop: '1px solid #161616' }}>
          <button onClick={() => onSave({ ...session, date, day, gym, lifts })} style={{ width: '100%', background: 'linear-gradient(180deg,#ffffff 0%,#e8e8e8 100%)', border: 'none', color: '#000', padding: '18px', borderRadius: 14, fontSize: 13, letterSpacing: 3, cursor: 'pointer', fontWeight: 700, fontFamily: "'DM Mono', monospace", boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.5), 0 1px 0 rgba(0,0,0,0.2)' }}>SAVE CHANGES →</button>
        </div>
      )}
    </div>
  )
}

// ── Setup Required Screen ─────────────────────────────────────────────────
function SetupRequired() {
  return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: "'DM Mono', monospace", color: '#e0e0e0' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Bebas+Neue&display=swap');*{box-sizing:border-box;}`}</style>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 44, letterSpacing: 7, color: '#fff', lineHeight: 1 }}>IRON LOG</div>
      <div style={{ fontSize: 10, color: '#2e2e2e', letterSpacing: 3, marginTop: 4, marginBottom: 36 }}>SETUP REQUIRED</div>

      <div style={{ maxWidth: 400, width: '100%', background: '#111', border: '1px solid #f59e0b33', borderRadius: 16, padding: '24px 20px' }}>
        <div style={{ fontSize: 32, marginBottom: 12, textAlign: 'center' }}>🔧</div>
        <div style={{ fontSize: 14, color: '#f59e0b', marginBottom: 16, textAlign: 'center', letterSpacing: 1 }}>Add your Firebase config</div>
        <div style={{ fontSize: 13, color: '#666', lineHeight: 1.7, marginBottom: 18 }}>
          Open <code style={{ background: '#0d0d0d', padding: '2px 8px', borderRadius: 4, color: '#e0e0e0' }}>src/firebase.js</code> and replace the placeholder values with your Firebase project config.
        </div>
        <div style={{ fontSize: 11, color: '#555', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 6 }}>1. Go to <span style={{ color: '#3b82f6' }}>console.firebase.google.com</span></div>
          <div style={{ marginBottom: 6 }}>2. Create project → Add web app</div>
          <div style={{ marginBottom: 6 }}>3. Copy <code style={{ color: '#888' }}>firebaseConfig</code> → paste in firebase.js</div>
          <div>4. Build → Realtime Database → Start in test mode</div>
        </div>
      </div>
    </div>
  )
}

// ── GymFilter ─────────────────────────────────────────────────────────────
// Horizontal chip row (ALL / each gym) used to scope the Trends & Progress views.
function GymFilter({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 14, paddingBottom: 4, marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16 }}>
      {['ALL', ...GYMS].map(g => {
        const active = value === g
        const c = g === 'ALL' ? '#fff' : GYM_META[g].color
        return (
          <button key={g} onClick={() => onChange(g)} style={{ flexShrink: 0, background: active ? (g === 'ALL' ? '#fff' : c + '22') : '#0e0e0e', border: `1.5px solid ${active ? (g === 'ALL' ? '#fff' : c + 'aa') : '#1e1e1e'}`, color: active ? (g === 'ALL' ? '#000' : c) : '#7a7a7a', padding: '8px 14px', borderRadius: 999, fontSize: 12, fontWeight: 600, letterSpacing: 1, fontFamily: "'DM Mono', monospace", boxShadow: active && g !== 'ALL' ? `0 0 14px ${c}33` : 'none' }}>{g === 'ALL' ? 'ALL GYMS' : g}</button>
        )
      })}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus]     = useState(isConfigured() ? 'loading' : 'unconfigured')
  const [sessions, setSessions] = useState([])
  const [editSess, setEditSess] = useState(null)

  const [view, setView]               = useState('history')
  const [formDay, setFormDay]         = useState('Push')
  const [formDate, setFormDate]       = useState(todayStr())
  const [formGym, setFormGym]         = useState(gymForDate(todayStr()))
  const [pending, setPending]         = useState([])
  const [addingLift, setAddingLift]   = useState(false)
  const [editPendIdx, setEditPendIdx] = useState(null)
  const [expandedId, setExpandedId]   = useState(null)
  const [progressEx, setProgressEx]   = useState('')
  const [metric, setMetric]           = useState('maxWeight')
  const [trendFilter, setTrendFilter] = useState('ALL')
  const [gymFilter, setGymFilter]     = useState('ALL')
  const [flash, setFlash]             = useState(null)

  const flashTimer = useRef(null)
  const showFlash = useCallback((msg, type = 'ok') => {
    clearTimeout(flashTimer.current)
    setFlash({ msg, type })
    flashTimer.current = setTimeout(() => setFlash(null), 2800)
  }, [])

  useEffect(() => {
    if (!isConfigured()) return

    let isFirst = true
    const unsub = dbSubscribe(data => {
      const arr = Array.isArray(data) ? data : []
      if (isFirst) {
        isFirst = false
        if (arr.length === 0) {
          dbWrite(SEED).catch(() => {})
          setSessions(sortS(SEED))
        } else {
          setSessions(sortS(arr))
        }
        setStatus('ready')
      } else {
        setSessions(sortS(arr))
      }
    })

    const errTimer = setTimeout(() => {
      if (status === 'loading') {
        dbRead()
          .then(d => { setSessions(sortS(Array.isArray(d) ? d : [])); setStatus('ready') })
          .catch(() => setStatus('error'))
      }
    }, 5000)

    return () => { unsub(); clearTimeout(errTimer) }
    // eslint-disable-next-line
  }, [])

  const allExercises = useMemo(
    () => [...new Set(sessions.flatMap(s => s.lifts.map(l => l.exercise)))].sort(),
    [sessions]
  )

  // Sessions narrowed to the selected gym — feeds the Trends & Progress analytics.
  const statsSessions = useMemo(
    () => gymFilter === 'ALL' ? sessions : sessions.filter(s => gymOf(s) === gymFilter),
    [sessions, gymFilter]
  )

  // For each split day, ordered list of exercises ever done on that day (most-recently-used first)
  const exercisesByDay = useMemo(() => {
    const map = {}
    SPLIT_DAYS.forEach(d => { map[d] = {} })
    sessions.forEach(s => s.lifts.forEach(l => {
      if (!map[s.day]) map[s.day] = {}
      const cur = map[s.day][l.exercise] || 0
      if (s.id > cur) map[s.day][l.exercise] = s.id
    }))
    const out = {}
    Object.entries(map).forEach(([d, exs]) => {
      out[d] = Object.entries(exs).sort((a, b) => b[1] - a[1]).map(([n]) => n)
    })
    return out
  }, [sessions])

  const liftIndex = useMemo(() => {
    const idx = {}
    sessions.forEach(s => s.lifts.forEach(l => {
      const key = l.exercise.toLowerCase().trim()
      if (!idx[key]) idx[key] = []
      idx[key].push({ session: s, lift: l })
    }))
    Object.values(idx).forEach(arr => arr.sort((a, b) => b.session.date.localeCompare(a.session.date) || b.session.id - a.session.id))
    return idx
  }, [sessions])

  const lastLiftFor = useCallback((name) => {
    const arr = liftIndex[name.toLowerCase().trim()]
    if (!arr?.length) return null
    return arr[0]
  }, [liftIndex])

  const prMap = useMemo(() => {
    const result = {}
    const byEx = {}
    const oldestFirst = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    oldestFirst.forEach(s => s.lifts.forEach((l, idx) => {
      const key = l.exercise.toLowerCase().trim()
      const bs = bestSet(l)
      const best = byEx[key] || { maxW: 0, repsAtMaxW: 0 }
      const isWeightPR = bs.weight > best.maxW
      const isRepPR = !isWeightPR && bs.weight === best.maxW && bs.reps > best.repsAtMaxW
      if (isWeightPR || isRepPR) {
        result[`${s.id}-${idx}`] = { weightPR: isWeightPR, repPR: isRepPR }
      }
      if (bs.weight > best.maxW) byEx[key] = { maxW: bs.weight, repsAtMaxW: bs.reps }
      else if (bs.weight === best.maxW) byEx[key] = { maxW: best.maxW, repsAtMaxW: Math.max(best.repsAtMaxW, bs.reps) }
      else byEx[key] = best
    }))
    return result
  }, [sessions])

  const streak = useMemo(() => calcStreak(sessions), [sessions])

  const progressData = useMemo(() => {
    if (!progressEx) return []
    return statsSessions
      .filter(s => s.lifts.some(l => eqEx(l.exercise, progressEx)))
      .map(s => {
        const lift = s.lifts.find(l => eqEx(l.exercise, progressEx))
        const totalReps = lift.sets.reduce((a, b) => a + b.reps, 0)
        const maxWeight = liftMaxWeight(lift)
        const avgWeight = +(lift.sets.reduce((a, b) => a + b.weight, 0) / lift.sets.length).toFixed(1)
        const volume = liftVolume(lift)
        return { date: fmt(s.date), maxWeight, avgWeight, volume, reps: totalReps }
      }).reverse()
  }, [sessions, progressEx])

  const trend = useMemo(() => analyzeTrend(progressData), [progressData])

  // Per-exercise progress: latest session vs previous occurrence. Used by the TRENDS view.
  const exerciseProgress = useMemo(() => {
    const groups = {}
    statsSessions.forEach(s => s.lifts.forEach(l => {
      const key = l.exercise.toLowerCase().trim()
      if (!groups[key]) groups[key] = []
      groups[key].push({ session: s, lift: l, displayName: l.exercise })
    }))
    const result = []
    Object.values(groups).forEach(arr => {
      arr.sort((a, b) => b.session.date.localeCompare(a.session.date) || b.session.id - a.session.id)
      const latest = arr[0]
      const latestBest = bestSet(latest.lift)
      const latestVol  = liftVolume(latest.lift)
      const row = {
        name: latest.displayName,
        day: latest.session.day,
        latestDate: latest.session.date,
        latestSessionId: latest.session.id,
        latestMaxW: latestBest.weight,
        latestReps: latestBest.reps,
        latestVol,
        latestSets: latest.lift.sets,
        prev: null,
        prevDate: null,
        prevMaxW: 0, prevReps: 0,
        prevSets: null,
        wDelta: 0, rDelta: 0, vDelta: 0,
        status: 'new',
      }
      const prev = arr[1]
      if (prev) {
        const prevBest = bestSet(prev.lift)
        const prevVol  = liftVolume(prev.lift)
        row.prev = prev
        row.prevDate = prev.session.date
        row.prevMaxW = prevBest.weight
        row.prevReps = prevBest.reps
        row.prevSets = prev.lift.sets
        row.wDelta = +(latestBest.weight - prevBest.weight).toFixed(1)
        row.rDelta = latestBest.reps - prevBest.reps
        row.vDelta = latestVol - prevVol
        if (row.wDelta > 0)        row.status = 'up-w'
        else if (row.wDelta < 0)   row.status = 'down'
        else if (row.rDelta > 0)   row.status = 'up-r'
        else if (row.rDelta < 0)   row.status = 'down'
        else                       row.status = 'same'
      }
      result.push(row)
    })
    result.sort((a, b) => b.latestDate.localeCompare(a.latestDate) || b.latestSessionId - a.latestSessionId || a.name.localeCompare(b.name))
    return result
  }, [statsSessions])

  const trendCounts = useMemo(() => {
    const c = { up: 0, same: 0, down: 0, new: 0 }
    exerciseProgress.forEach(r => {
      if (r.status === 'up-w' || r.status === 'up-r') c.up++
      else if (r.status === 'same') c.same++
      else if (r.status === 'down') c.down++
      else c.new++
    })
    return c
  }, [exerciseProgress])

  const filteredTrends = useMemo(
    () => trendFilter === 'ALL' ? exerciseProgress : exerciseProgress.filter(r => r.day === trendFilter),
    [exerciseProgress, trendFilter]
  )

  const commitSessions = useCallback(async data => {
    const sorted = sortS(data)
    const previous = sessions
    setSessions(sorted)
    setStatus('saving')
    try {
      await dbWrite(sorted)
      setStatus('ready')
      return sorted
    } catch {
      setSessions(previous)
      setStatus('ready')
      showFlash('Save failed — try again', 'err')
      return null
    }
  }, [sessions, showFlash])

  const saveSession = async ({ goToHistory = false } = {}) => {
    if (!pending.length) return showFlash('Add at least one lift', 'err')
    const s = { id: Date.now(), date: formDate, day: formDay, gym: formGym, lifts: pending }
    const result = await commitSessions([s, ...sessions])
    if (result) {
      vibrate(20)
      setPending([]); setAddingLift(false); setEditPendIdx(null)
      showFlash(formDay + ' saved! ☁️')
      if (goToHistory) setView('history')
    }
  }

  const updateSession = async updated => {
    const result = await commitSessions(sessions.map(s => s.id === updated.id ? updated : s))
    if (result) { setEditSess(null); showFlash('Session updated!') }
  }

  const deleteSession = async id => {
    if (!confirm('Delete this session?')) return
    const result = await commitSessions(sessions.filter(s => s.id !== id))
    if (result) {
      if (expandedId === id) setExpandedId(null)
      showFlash('Deleted')
    }
  }

  const color    = COLORS[formDay]
  const isSaving = status === 'saving'

  if (status === 'unconfigured') return <SetupRequired />

  if (status === 'loading') return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap');@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 40, letterSpacing: 8, color: '#1a1a1a', marginBottom: 24 }}>IRON LOG</div>
      <div style={{ width: 36, height: 36, border: '3px solid #1e1e1e', borderTop: '3px solid #22c55e', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <div style={{ color: '#333', fontSize: 11, letterSpacing: 2, marginTop: 16 }}>CONNECTING TO FIREBASE</div>
    </div>
  )

  if (status === 'error') return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Mono', monospace", padding: 32 }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
      <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 24, textAlign: 'center', lineHeight: 1.8 }}>Could not connect to Firebase.<br />Check your config and connection.</div>
      <button onClick={() => window.location.reload()} style={{ background: '#fff', border: 'none', color: '#000', padding: '14px 32px', borderRadius: 12, fontSize: 13, letterSpacing: 2, cursor: 'pointer', fontWeight: 700, fontFamily: "'DM Mono', monospace" }}>RETRY</button>
    </div>
  )

  if (editSess) return <SessionEditor session={editSess} exerciseHistory={allExercises} exercisesByDay={exercisesByDay} lastLiftFor={lastLiftFor} onSave={updateSession} onClose={() => setEditSess(null)} />

  return (
    <div style={{ background: '#090909', minHeight: '100dvh', fontFamily: "'DM Mono', monospace", color: '#e0e0e0', maxWidth: 480, margin: '0 auto', paddingBottom: 90 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500;600&family=Bebas+Neue&display=swap');
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
        html,body{overscroll-behavior-y:none;background:#090909;}
        body{position:relative;background:radial-gradient(circle at top,#0e0e0e 0%,#090909 60%);}
        ::placeholder{color:#5a5a5a;}
        input,select,button,textarea{-webkit-appearance:none;appearance:none;font-family:'DM Mono',monospace;font-size:16px;}
        input:focus,select:focus{outline:none;border-color:#666!important;}
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
        input[type=number]{-moz-appearance:textfield;}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5);}
        button{transition-property:transform,background,color,border-color,box-shadow,opacity;transition-duration:.16s;transition-timing-function:cubic-bezier(.2,0,0,1);cursor:pointer;will-change:transform;}
        button:active:not(:disabled){transform:scale(.96);}
        .card{box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 1px 2px rgba(0,0,0,.4),0 4px 12px rgba(0,0,0,.25);}
        .card-elev{box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 2px 6px rgba(0,0,0,.5),0 12px 32px rgba(0,0,0,.35);}
        .balance{text-wrap:balance;}
        .pretty{text-wrap:pretty;}
        .session-card{animation:cardIn .42s cubic-bezier(.2,0,0,1) both;}
        .chev{transition:transform .25s cubic-bezier(.2,0,0,1);}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
        @keyframes slideDown{from{opacity:0;transform:translate(-50%,-14px)}to{opacity:1;transform:translate(-50%,0)}}
        @keyframes cardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes accentSlide{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}
      `}</style>

      {flash && (
        <div style={{ position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 12px)', left: '50%', transform: 'translateX(-50%)', zIndex: 999, background: flash.type === 'err' ? 'linear-gradient(180deg,#3b0a0a,#260606)' : 'linear-gradient(180deg,#0a2e1a,#062012)', border: `1px solid ${flash.type === 'err' ? '#ef444466' : '#22c55e66'}`, color: flash.type === 'err' ? '#fca5a5' : '#86efac', padding: '12px 22px', borderRadius: 12, fontSize: 13, whiteSpace: 'nowrap', boxShadow: '0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)', animation: 'slideDown .28s cubic-bezier(.2,0,0,1)', fontWeight: 500 }}>{flash.msg}</div>
      )}

      <div style={{ padding: 'calc(env(safe-area-inset-top, 0px) + 28px) 16px 16px', borderBottom: '1px solid #141414', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', position: 'relative' }}>
        <div>
          <div className="balance" style={{ fontFamily: "'Bebas Neue'", fontSize: 44, letterSpacing: 6, color: '#fff', lineHeight: 1 }}>IRON LOG</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ display: 'inline-block', width: 32, height: 2, background: COLORS[formDay], borderRadius: 1, boxShadow: `0 0 8px ${COLORS[formDay]}99` }} />
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: isSaving ? '#f59e0b' : '#22c55e', animation: isSaving ? 'pulse 1s ease infinite' : 'none', boxShadow: isSaving ? '0 0 8px #f59e0b88' : '0 0 8px #22c55e66' }} />
            <div style={{ fontSize: 11, color: '#888', letterSpacing: 2, fontWeight: 600 }}>{isSaving ? 'SAVING' : 'SYNCED'}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 34, color: '#fff', letterSpacing: 2, lineHeight: 1, display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 8 }}>
            {streak > 0 && <span style={{ color: '#f59e0b', textShadow: '0 0 16px #f59e0b66' }}>🔥{streak}</span>}
            <span style={{ color: streak > 0 ? '#2a2a2a' : '#666' }}>{sessions.length}</span>
          </div>
          <div style={{ fontSize: 11, color: '#888', letterSpacing: 1.5, marginTop: 6, fontWeight: 500 }}>
            {streak > 0 ? `${streak}-DAY STREAK · ` : ''}{sessions.length} SESSIONS
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 16px 0' }}>

        {view === 'log' && (
          <>
            <input type="date" value={formDate} onChange={e => { setFormDate(e.target.value); setFormGym(gymForDate(e.target.value)) }} style={{ ...IS, color: '#888', marginBottom: 12 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
              {GYMS.map(g => {
                const gc = GYM_META[g].color
                return (
                  <button key={g} onClick={() => setFormGym(g)} style={{ background: formGym === g ? gc + '22' : '#0e0e0e', border: `1.5px solid ${formGym === g ? gc + 'aa' : '#1e1e1e'}`, color: formGym === g ? gc : '#7a7a7a', padding: '13px 6px', borderRadius: 11, fontSize: 13, fontWeight: 600, boxShadow: formGym === g ? `0 0 18px ${gc}33, inset 0 1px 0 ${gc}22` : 'inset 0 1px 0 rgba(255,255,255,0.02)' }}>{g}</button>
                )
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 20 }}>
              {SPLIT_DAYS.map(d => (
                <button key={d} onClick={() => setFormDay(d)} style={{ background: formDay === d ? COLORS[d] + '22' : '#0e0e0e', border: `1.5px solid ${formDay === d ? COLORS[d] + 'aa' : '#1e1e1e'}`, color: formDay === d ? COLORS[d] : '#7a7a7a', padding: '15px 6px', borderRadius: 11, fontSize: 13, fontWeight: 600, boxShadow: formDay === d ? `0 0 18px ${COLORS[d]}33, inset 0 1px 0 ${COLORS[d]}22` : 'inset 0 1px 0 rgba(255,255,255,0.02)' }}>{d}</button>
              ))}
            </div>

            {pending.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 8 }}>QUEUED — {pending.length} LIFT{pending.length > 1 ? 'S' : ''}</div>
                {pending.map((l, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    {editPendIdx === i
                      ? <LiftBuilder lift={l} color={color} day={formDay} exerciseHistory={allExercises} dayExercises={exercisesByDay[formDay] || []} lastLiftFor={lastLiftFor} confirmLabel="SAVE LIFT ✓"
                          onConfirm={u => { setPending(p => p.map((x, j) => j === i ? u : x)); setEditPendIdx(null) }}
                          onCancel={() => setEditPendIdx(null)} />
                      : <div className="card" style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: 12, overflow: 'hidden' }}>
                          <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 14, color: '#ccc' }}>{l.exercise}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => setEditPendIdx(i)} style={{ background: '#1e1e1e', border: 'none', color: '#888', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>EDIT</button>
                              <button onClick={() => setPending(p => p.filter((_, j) => j !== i))} style={{ background: '#1e1e1e', border: 'none', color: '#555', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>✕</button>
                            </div>
                          </div>
                          <div style={{ padding: '0 14px 12px', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {l.sets.map((s, j) => <span key={j} style={{ background: color + '18', border: `1px solid ${color}33`, borderRadius: 6, padding: '5px 11px', fontSize: 13, color }}>S{j + 1}:{fmtW(s.weight)}×{s.reps}</span>)}
                          </div>
                        </div>}
                  </div>
                ))}
              </div>
            )}

            {addingLift && editPendIdx === null
              ? <div style={{ marginBottom: 14 }}>
                  <LiftBuilder lift={null} color={color} day={formDay} exerciseHistory={allExercises} dayExercises={exercisesByDay[formDay] || []} lastLiftFor={lastLiftFor} confirmLabel="ADD LIFT ✓"
                    onConfirm={l => { setPending(p => [...p, l]); setAddingLift(false) }}
                    onCancel={() => setAddingLift(false)} />
                </div>
              : editPendIdx === null && (
                <button onClick={() => setAddingLift(true)} style={{ width: '100%', background: '#111', border: `1.5px dashed ${color}55`, color, padding: '17px', borderRadius: 12, fontSize: 13, letterSpacing: 2, cursor: 'pointer', marginBottom: 14 }}>+ ADD LIFT</button>
              )
            }
            {pending.length > 0 && !addingLift && editPendIdx === null && (
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 8 }}>
                <button onClick={() => saveSession()} disabled={isSaving} style={{ background: isSaving ? '#1e1e1e' : 'linear-gradient(180deg,#ffffff 0%,#e8e8e8 100%)', border: 'none', color: isSaving ? '#555' : '#000', padding: '18px', borderRadius: 14, fontSize: 13, letterSpacing: 3, cursor: isSaving ? 'default' : 'pointer', fontWeight: 700, boxShadow: isSaving ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.5), 0 1px 0 rgba(0,0,0,0.2)' }}>
                  {isSaving ? 'SAVING...' : 'SAVE SESSION'}
                </button>
                <button onClick={() => saveSession({ goToHistory: true })} disabled={isSaving} style={{ background: '#111', border: '1.5px solid #2a2a2a', color: isSaving ? '#444' : '#aaa', padding: '18px 8px', borderRadius: 14, fontSize: 11, letterSpacing: 2, cursor: isSaving ? 'default' : 'pointer', fontWeight: 600 }}>
                  SAVE & VIEW →
                </button>
              </div>
            )}
          </>
        )}

        {view === 'history' && (
          <>
            <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 14 }}>{sessions.length} SESSIONS LOGGED</div>
            {sessions.length === 0 && <div style={{ textAlign: 'center', color: '#555', fontSize: 14, padding: '80px 0' }}>No sessions yet. Tap + to log.</div>}
            {sessions.map((s, idx) => {
              const c = COLORS[s.day], isOpen = expandedId === s.id
              const vol = s.lifts.reduce((acc, l) => acc + liftVolume(l), 0)
              const hasPR = s.lifts.some((_, i) => prMap[`${s.id}-${i}`])
              const gm = GYM_META[gymOf(s)]
              return (
                <div key={s.id} className="session-card card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 14, marginBottom: 10, overflow: 'hidden', animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
                  <button onClick={() => setExpandedId(isOpen ? null : s.id)} style={{ width: '100%', background: 'none', border: 'none', padding: '15px 16px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}>
                    <div style={{ width: 4, height: 44, borderRadius: 2, background: c, flexShrink: 0, boxShadow: `0 0 12px ${c}66` }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 2, color: '#fff' }}>{fmtF(s.date)}</div>
                        <span style={{ background: gm.color + '22', border: `1px solid ${gm.color}55`, color: gm.color, fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '2px 7px', borderRadius: 5 }}>{gm.short}</span>
                        {hasPR && <span style={{ fontSize: 12 }}>🔥</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#9a9a9a', marginTop: 3 }}><span style={{ color: c, fontWeight: 600 }}>{s.day}</span> · {s.lifts.length} lifts · {vol.toLocaleString()} lbs</div>
                    </div>
                    <div className="chev" style={{ color: '#666', fontSize: 22, transform: isOpen ? 'rotate(90deg)' : 'none' }}>›</div>
                  </button>
                  {isOpen && (
                    <div style={{ borderTop: '1px solid #161616' }}>
                      {s.lifts.map((l, i) => {
                        const pr = prMap[`${s.id}-${i}`]
                        return (
                          <div key={i} style={{ padding: '12px 16px', borderBottom: i < s.lifts.length - 1 ? '1px solid #141414' : 'none' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                              <div style={{ fontSize: 14, color: '#ccc' }}>{l.exercise}</div>
                              {pr && <div style={{ background: pr.weightPR ? '#f59e0b22' : '#06b6d422', color: pr.weightPR ? '#f59e0b' : '#06b6d4', border: `1px solid ${pr.weightPR ? '#f59e0b66' : '#06b6d466'}`, fontSize: 11, padding: '5px 9px', borderRadius: 6, letterSpacing: 1, fontWeight: 600 }}>{pr.weightPR ? '🔥 WEIGHT PR' : '📈 REP PR'}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                              {l.sets.map((x, j) => <span key={j} style={{ background: c + '18', border: `1px solid ${c}33`, borderRadius: 6, padding: '5px 11px', fontSize: 13, color: c }}>S{j + 1}:{fmtW(x.weight)}×{x.reps}</span>)}
                              <span style={{ background: '#1a1a1a', borderRadius: 6, padding: '5px 11px', fontSize: 12, color: '#555' }}>vol:{liftVolume(l)}</span>
                            </div>
                          </div>
                        )
                      })}
                      <div style={{ padding: '10px 16px', background: '#0c0c0c', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: '#888' }}>TOTAL: <span style={{ color: '#ddd' }}>{vol.toLocaleString()} lbs</span></span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => setEditSess(s)} style={{ background: '#1e1e1e', border: 'none', color: '#888', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>EDIT</button>
                          <button onClick={() => deleteSession(s.id)} style={{ background: 'none', border: '1px solid #3b0a0a', color: '#ef444488', padding: '11px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>DELETE</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {view === 'trends' && (
          <>
            <GymFilter value={gymFilter} onChange={setGymFilter} />
            {exerciseProgress.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#555', fontSize: 14, padding: '80px 0' }}>{gymFilter === 'ALL' ? 'Log some sessions first.' : `No sessions logged at ${gymFilter} yet.`}</div>
            ) : (
              <>
                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 12 }}>SESSION-OVER-SESSION</div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
                  {[
                    { label: 'UP',     val: trendCounts.up,   color: '#22c55e', Ic: IconArrowUp },
                    { label: 'SAME',   val: trendCounts.same, color: '#f59e0b', Ic: IconDash },
                    { label: 'DOWN',   val: trendCounts.down, color: '#ef4444', Ic: IconArrowDn },
                    { label: 'NEW',    val: trendCounts.new,  color: '#a855f7', Ic: IconSpark },
                  ].map(({ label, val, color: c, Ic }) => (
                    <div key={label} className="card" style={{ background: '#111', border: `1px solid ${c}33`, borderRadius: 12, padding: '14px 6px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: c, marginBottom: 6 }}><Ic size={18} w={2.2} /></div>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 26, color: '#fff', letterSpacing: 1, lineHeight: 1 }}>{val}</div>
                      <div style={{ fontSize: 10, color: c, letterSpacing: 1.5, marginTop: 5, fontWeight: 600 }}>{label}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 14, paddingBottom: 4, marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16 }}>
                  {['ALL', ...SPLIT_DAYS].map(d => {
                    const active = trendFilter === d
                    const c = d === 'ALL' ? '#fff' : COLORS[d]
                    return (
                      <button key={d} onClick={() => setTrendFilter(d)} style={{ flexShrink: 0, background: active ? (d === 'ALL' ? '#fff' : c + '22') : '#0e0e0e', border: `1.5px solid ${active ? (d === 'ALL' ? '#fff' : c + 'aa') : '#1e1e1e'}`, color: active ? (d === 'ALL' ? '#000' : c) : '#7a7a7a', padding: '8px 14px', borderRadius: 999, fontSize: 12, fontWeight: 600, letterSpacing: 1, fontFamily: "'DM Mono', monospace", boxShadow: active && d !== 'ALL' ? `0 0 14px ${c}33` : 'none' }}>{d}</button>
                    )
                  })}
                </div>

                {filteredTrends.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#555', fontSize: 13, padding: '60px 0' }}>No {trendFilter.toLowerCase()} exercises logged yet.</div>
                )}

                {filteredTrends.map((r, idx) => {
                  const dayColor = COLORS[r.day]
                  const statusMeta = {
                    'up-w': { color: '#22c55e', label: `+${r.wDelta}lb`,    Ic: IconArrowUp },
                    'up-r': { color: '#06b6d4', label: `+${r.rDelta} rep${Math.abs(r.rDelta) === 1 ? '' : 's'}`, Ic: IconArrowUp },
                    'same': { color: '#f59e0b', label: 'PLATEAU',           Ic: IconDash },
                    'down': { color: '#ef4444', label: r.wDelta !== 0 ? `${r.wDelta}lb` : `${r.rDelta} reps`, Ic: IconArrowDn },
                    'new':  { color: '#a855f7', label: 'NEW',               Ic: IconSpark },
                  }[r.status]
                  return (
                    <div key={r.name + r.latestSessionId} className="session-card card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 14, marginBottom: 10, overflow: 'hidden', animationDelay: `${Math.min(idx, 8) * 35}ms` }}>
                      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 4, height: 50, borderRadius: 2, background: dayColor, flexShrink: 0, boxShadow: `0 0 12px ${dayColor}66` }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, color: '#fff', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                          <div style={{ fontSize: 11, color: '#9a9a9a', marginTop: 4, letterSpacing: 0.3 }}>
                            <span style={{ color: dayColor, fontWeight: 600 }}>{r.day}</span> · {fmt(r.latestDate)}
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: statusMeta.color + '1a', border: `1px solid ${statusMeta.color}55`, color: statusMeta.color, fontSize: 11, padding: '5px 10px', borderRadius: 8, fontWeight: 600, letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
                            <statusMeta.Ic size={13} w={2.4} />
                            <span>{statusMeta.label}</span>
                          </div>
                        </div>
                      </div>
                      <div style={{ borderTop: '1px solid #1a1a1a', padding: '10px 16px', background: '#0c0c0c', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                        {r.prevSets ? (
                          <>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, color: '#666', letterSpacing: 1, marginBottom: 4, fontWeight: 600 }}>PREV · {fmt(r.prevDate)}</div>
                              <div style={{ color: '#888', fontSize: 13 }}>{r.prevMaxW === 0 ? 'BW' : r.prevMaxW}lb × {r.prevReps} reps</div>
                            </div>
                            <div style={{ color: '#444', fontSize: 16 }}>→</div>
                            <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                              <div style={{ fontSize: 10, color: '#666', letterSpacing: 1, marginBottom: 4, fontWeight: 600 }}>NOW</div>
                              <div style={{ color: '#fff', fontSize: 13, fontWeight: 500 }}>{r.latestMaxW === 0 ? 'BW' : r.latestMaxW}lb × {r.latestReps} reps</div>
                            </div>
                          </>
                        ) : (
                          <div style={{ flex: 1, color: '#888', fontSize: 12 }}>
                            First time · {r.latestMaxW === 0 ? 'BW' : r.latestMaxW}lb × {r.latestReps} reps
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}

        {view === 'progress' && (
          <>
            <GymFilter value={gymFilter} onChange={setGymFilter} />
            <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 8 }}>SELECT EXERCISE</div>
            <select value={progressEx} onChange={e => setProgressEx(e.target.value)} style={{ ...IS, color: progressEx ? '#e0e0e0' : '#666' }}>
              <option value="">— Pick an exercise —</option>
              {allExercises.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
            {progressEx && progressData.length > 0 && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                  {[['BEST WT', Math.max(...progressData.map(d => d.maxWeight)) + 'lb'], ['SESSIONS', progressData.length], ['BEST VOL', Math.max(...progressData.map(d => d.volume)).toLocaleString()]].map(([label, val]) => (
                    <div key={label} className="card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 12, padding: '16px 8px', textAlign: 'center' }}>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 28, color: '#fff', letterSpacing: 1, lineHeight: 1 }}>{val}</div>
                      <div style={{ fontSize: 11, color: '#888', letterSpacing: 1.5, marginTop: 6 }}>{label}</div>
                    </div>
                  ))}
                </div>

                <div className="card" style={{ background: '#111', border: `1px solid ${trend.color}44`, borderRadius: 14, padding: '16px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 6, height: 42, borderRadius: 3, background: trend.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, letterSpacing: 3, color: trend.color, lineHeight: 1 }}>{trend.label}</div>
                    <div style={{ fontSize: 12, color: '#aaa', marginTop: 6, lineHeight: 1.45 }}>{trend.detail}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', background: '#111', border: '1px solid #1a1a1a', borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
                  {[['maxWeight', 'MAX WT'], ['avgWeight', 'AVG WT'], ['volume', 'VOLUME'], ['reps', 'REPS']].map(([k, l]) => (
                    <button key={k} onClick={() => setMetric(k)} style={{ flex: 1, background: metric === k ? '#1e1e1e' : 'none', border: 'none', color: metric === k ? '#fff' : '#888', padding: '14px 2px', fontSize: 12, letterSpacing: 1, cursor: 'pointer', fontWeight: metric === k ? 600 : 400 }}>{l}</button>
                  ))}
                </div>
                <div className="card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 14, padding: '16px 4px 8px', marginBottom: 16 }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={progressData} margin={{ left: 0, right: 8 }}>
                      <XAxis dataKey="date" tick={{ fill: '#888', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#888', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={44} />
                      <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a', fontFamily: 'DM Mono', fontSize: 12, color: '#fff', borderRadius: 8 }} labelStyle={{ color: '#888' }} />
                      <Line type="monotone" dataKey={metric} stroke="#e0e0e0" strokeWidth={2.5} dot={{ fill: '#e0e0e0', r: 4, strokeWidth: 0 }} activeDot={{ r: 6, fill: '#fff' }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 10 }}>PER SESSION</div>
                {[...progressData].reverse().map((d, i) => (
                  <div key={i} className="card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 12, padding: '14px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 14, color: '#ddd', fontWeight: 500 }}>{d.date}</div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>vol:{d.volume.toLocaleString()} · reps:{d.reps} · avg:{d.avgWeight}lb</div>
                    </div>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 32, color: '#fff', letterSpacing: 1 }}>{d.maxWeight}<span style={{ fontFamily: "'DM Mono'", fontSize: 12, color: '#888', marginLeft: 3 }}>lb</span></div>
                  </div>
                ))}
              </>
            )}
            {progressEx && progressData.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: '60px 0', fontSize: 14 }}>No {progressEx} sessions at {gymFilter === 'ALL' ? 'any gym' : gymFilter} yet.</div>}
            {!progressEx && allExercises.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: '60px 0', fontSize: 14 }}>Log sessions first.</div>}
          </>
        )}
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'rgba(13,13,13,0.92)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderTop: '1px solid #1f1f1f', display: 'flex', zIndex: 20, paddingBottom: 'env(safe-area-inset-bottom,8px)', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}>
        {[['log', IconPlus, 'LOG'], ['history', IconList, 'HISTORY'], ['trends', IconBars, 'TRENDS'], ['progress', IconTrending, 'PROGRESS']].map(([k, Ic, label]) => {
          const active = view === k
          return (
            <button key={k} onClick={() => setView(k)} style={{ flex: 1, background: 'none', border: 'none', color: active ? '#fff' : '#666', padding: '14px 0 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minHeight: 60, position: 'relative' }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? '#fff' : '#5a5a5a', transition: 'color .15s' }}><Ic size={23} w={active ? 2.5 : 2} /></span>
              <span style={{ fontSize: 10, letterSpacing: 2, fontFamily: "'DM Mono', monospace", fontWeight: active ? 600 : 400, color: active ? '#fff' : '#666' }}>{label}</span>
              {active && <span style={{ position: 'absolute', bottom: 4, width: 28, height: 2, background: '#fff', borderRadius: 1, animation: 'accentSlide .3s cubic-bezier(.2,0,0,1) both' }} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
