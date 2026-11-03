import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { dbRead, dbWrite, dbSubscribe, isConfigured, subscribeAuth, signInWithGoogle, signOutUser } from './firebase.js'

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
// ── helpers ───────────────────────────────────────────────────────────────
// Local-calendar YYYY-MM-DD. (toISOString() is UTC, which rolls over to "tomorrow"
// in the evening for US time zones and mis-dated late-night sessions.)
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayStr = () => localISO(new Date())
const fmt   = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtF  = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const dc    = o => JSON.parse(JSON.stringify(o))
const sortS = arr => [...arr].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
// Parse a session date to a comparable timestamp. Robust to legacy/non-padded date
// strings (e.g. '2025-5-9') that would mis-order under a plain lexical string compare.
const dateVal = d => { const t = new Date(d + 'T00:00:00').getTime(); return isNaN(t) ? (new Date(d).getTime() || 0) : t }
const gymForDate = d => (d >= GYM_CUTOVER ? 'Ping' : 'Planet Fitness')  // ISO string compare
const gymOf = s => s.gym || gymForDate(s.date)                          // backfills legacy records
const liftVolume = l => l.sets.reduce((a, x) => a + x.weight * x.reps, 0)
const bestSet = l => l.sets.reduce(
  (best, s) => (s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps)) ? s : best,
  { weight: 0, reps: 0 }
)
const eqEx = (a, b) => a.toLowerCase().trim() === b.toLowerCase().trim()
const exKey = n => n.toLowerCase().trim()
const vibrate = (ms = 15) => navigator.vibrate?.(ms)
const fmtW = w => w === 0 ? 'BW' : w  // bodyweight display
// Chronological order of two sessions (date, then id as a same-day tiebreak).
const cmpSess = (a, b) => dateVal(a.date) - dateVal(b.date) || Number(a.id) - Number(b.id)

// ── trend reset ───────────────────────────────────────────────────────────
// A lift can carry `trendStart: true`, meaning "trends / PRs for this exercise
// start fresh at this session". Earlier sessions stay in history and on the graph
// but are ignored for comparisons — so a typo'd 300 instead of 30 doesn't make every
// later session read as DOWN. Stored on the lift itself so it lives inside the
// existing `sessions` path (no new DB rules needed) and syncs like everything else.
const TREND_FLAG = 'trendStart'

// Draft (unsaved Log-tab session) survives reloads / the phone killing the tab.
const DRAFT_KEY = 'ironlog.draft.v1'
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || null } catch { return null } }
const saveDraft = d => { try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY) } catch { /* storage unavailable */ } }

// Streak: count consecutive prior days with at least one session, ending today or yesterday
function calcStreak(sessions) {
  if (!sessions.length) return 0
  const dates = new Set(sessions.map(s => s.date))
  let streak = 0
  const d = new Date()
  if (!dates.has(localISO(d))) d.setDate(d.getDate() - 1)
  while (dates.has(localISO(d))) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

// Weight-first progressive-overload verdict across the last N sessions of an exercise.
// data is the per-session top-set array from the Progress view (oldest → newest): { topW, topR }.
// Priority: top-set weight first, reps only as a secondary signal at equal weight.
function analyzeOverload(data) {
  if (!data || data.length < 3) {
    return { label: 'NEW', color: '#888', detail: `${data?.length || 0} session${data?.length === 1 ? '' : 's'} — log 3+ to see a trend` }
  }
  const recent = data.slice(-Math.min(5, data.length))
  const n = recent.length
  const wDelta = +(recent[n - 1].topW - recent[0].topW).toFixed(1)
  const rDelta = recent[n - 1].topR - recent[0].topR
  if (wDelta > 0) return { label: 'OVERLOADING', color: '#22c55e', detail: `+${wDelta}lb on your top set over last ${n}` }
  if (wDelta < 0) return { label: 'REGRESSING', color: '#ef4444', detail: `${wDelta}lb on your top set over last ${n}` }
  if (rDelta > 0) return { label: 'BUILDING REPS', color: '#3b82f6', detail: `same top weight, +${rDelta} reps over last ${n} — close to a weight bump` }
  if (rDelta < 0) return { label: 'REGRESSING', color: '#ef4444', detail: `same weight but ${rDelta} reps on your top set over last ${n}` }
  return { label: 'PLATEAU', color: '#f59e0b', detail: `no change in your top set over last ${n} sessions` }
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
    const clean = filled.map(s => ({ weight: +s.weight, reps: +s.reps }))
    // Typo guard: a top set wildly off from last time (300 vs 30) is usually a fat finger.
    const prevTop = prev ? bestSet(prev.lift).weight : 0
    const newTop = bestSet({ sets: clean }).weight
    if (prevTop > 0 && Math.abs(newTop - prevTop) >= 20 && (newTop >= prevTop * 1.75 || newTop <= prevTop * 0.5)) {
      if (!confirm(`Double-check: top set is ${newTop} lb, last time was ${prevTop} lb.\n\nSave anyway?`)) return
    }
    // Keep extra fields (e.g. the trend-reset marker) when editing the same exercise.
    const keep = lift && eqEx(lift.exercise, name) ? lift : {}
    onConfirm({ ...keep, exercise: name.trim(), sets: clean })
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
  const dirty = date !== session.date || day !== session.day || gym !== gymOf(session) || JSON.stringify(lifts) !== JSON.stringify(session.lifts)
  const close = () => { if (!dirty || confirm('Discard unsaved changes?')) onClose() }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#090909', zIndex: 100, overflowY: 'auto', maxWidth: 480, margin: '0 auto', fontFamily: "'DM Mono', monospace", paddingBottom: 120 }}>
      <div style={{ padding: '44px 16px 16px', borderBottom: '1px solid #161616', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={close} aria-label="Back" style={{ background: 'none', border: 'none', color: '#555', fontSize: 26, cursor: 'pointer' }}>‹</button>
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
          <button onClick={() => lifts.length ? onSave({ ...session, date, day, gym, lifts }) : alert('A session needs at least one lift — delete it from History instead.')} style={{ width: '100%', background: 'linear-gradient(180deg,#ffffff 0%,#e8e8e8 100%)', border: 'none', color: '#000', padding: '18px', borderRadius: 14, fontSize: 13, letterSpacing: 3, cursor: 'pointer', fontWeight: 700, fontFamily: "'DM Mono', monospace", boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.5), 0 1px 0 rgba(0,0,0,0.2)' }}>SAVE CHANGES →</button>
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

// ── Sign In Screen ────────────────────────────────────────────────────────
// Gate shown when Firebase is configured but no one is signed in. The locked
// security rules only allow the owner's account, so sign-in is required before
// any data can be read or written.
function SignInScreen() {
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try {
      await signInWithGoogle()
      // On success onAuthStateChanged unmounts this screen; no need to reset busy.
    } catch (e) {
      setBusy(false)
      setErr(
        e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request' ? 'Sign-in cancelled.'
        : e?.code === 'auth/popup-blocked' ? 'Your browser blocked the sign-in popup — allow popups for this site and try again.'
        : e?.code === 'auth/network-request-failed' ? 'Network error — check your connection and try again.'
        : e?.code === 'auth/unauthorized-domain' ? 'This domain isn’t authorized in Firebase Auth settings.'
        : e?.code === 'auth/operation-not-allowed' ? 'Google sign-in isn’t enabled in the Firebase console yet.'
        : (e?.message || 'Sign-in failed. Try again.')
      )
    }
  }
  return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: "'DM Mono', monospace", color: '#e0e0e0' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Bebas+Neue&display=swap');*{box-sizing:border-box;}`}</style>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 48, letterSpacing: 8, color: '#fff', lineHeight: 1 }}>IRON LOG</div>
      <div style={{ fontSize: 10, color: '#2e2e2e', letterSpacing: 3, marginTop: 4, marginBottom: 40 }}>PRIVATE · OWNER ACCESS ONLY</div>

      <button onClick={go} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: 'none', color: '#1a1a1a', padding: '15px 26px', borderRadius: 12, fontSize: 14, fontWeight: 700, letterSpacing: 1, fontFamily: "'DM Mono', monospace", opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>
        {busy ? 'SIGNING IN…' : 'SIGN IN WITH GOOGLE'}
      </button>

      {err && <div style={{ marginTop: 20, maxWidth: 320, textAlign: 'center', fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>{err}</div>}
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
  const [user, setUser]         = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [sessions, setSessions] = useState([])
  const [editSess, setEditSess] = useState(null)

  const [draft] = useState(loadDraft)
  const [view, setView]               = useState(draft?.pending?.length ? 'log' : 'history')
  const [formDay, setFormDay]         = useState(draft?.day && COLORS[draft.day] ? draft.day : 'Push')
  const [formDate, setFormDate]       = useState(draft?.date || todayStr())
  const [formGym, setFormGym]         = useState(draft?.gym || gymForDate(todayStr()))
  const [pending, setPending]         = useState(Array.isArray(draft?.pending) ? draft.pending : [])
  const [addingLift, setAddingLift]   = useState(false)
  const [editPendIdx, setEditPendIdx] = useState(null)
  const [expandedId, setExpandedId]   = useState(null)
  const [progressEx, setProgressEx]   = useState('')
  const [trendFilter, setTrendFilter] = useState('ALL')
  const [gymFilter, setGymFilter]     = useState('ALL')
  const [flash, setFlash]             = useState(null)

  const flashTimer = useRef(null)
  // Always-current sessions for async callbacks (UNDO buttons fire seconds later).
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  // action: optional { label, fn } rendered as a tappable button (e.g. UNDO).
  const showFlash = useCallback((msg, type = 'ok', action = null) => {
    clearTimeout(flashTimer.current)
    setFlash({ msg, type, action })
    flashTimer.current = setTimeout(() => setFlash(null), action ? 6000 : 2800)
  }, [])

  // Persist the in-progress Log session so a reload / killed tab doesn't lose it.
  useEffect(() => {
    saveDraft(pending.length ? { date: formDate, day: formDay, gym: formGym, pending } : null)
  }, [pending, formDate, formDay, formGym])

  // Track the signed-in user. Fires immediately with the restored session.
  useEffect(() => {
    if (!isConfigured()) { setAuthReady(true); return }
    const unsub = subscribeAuth(u => {
      if (u) console.log('[ironlog] signed in as', u.email, '· uid:', u.uid)
      else setSessions([])
      setUser(u)
      setAuthReady(true)
    })
    return unsub
  }, [])

  // Load sessions once a user is signed in. Re-runs on sign-in / sign-out.
  // firebase.js already normalizes the payload to an array, and we never write
  // on load — an empty result just shows the empty state, never overwrites.
  useEffect(() => {
    if (!isConfigured() || !user) return
    setStatus('loading')

    let settled = false
    const load = arr => {
      if (settled) { setSessions(sortS(arr)); return } // live update after first load
      settled = true
      setSessions(sortS(arr))
      setStatus('ready')
    }
    const fail = () => { if (!settled) { settled = true; setStatus('error') } }

    // onError surfaces a denied read (e.g. rules/UID mismatch) right away.
    const unsub = dbSubscribe(load, fail)

    // Fallback only if the first snapshot never arrives (stalled connection).
    const errTimer = setTimeout(() => {
      if (!settled) dbRead().then(arr => { if (!settled) load(arr) }).catch(fail)
    }, 5000)

    return () => { unsub(); clearTimeout(errTimer) }
  }, [user])

  // One entry per exercise, case/whitespace-insensitive ("Bench press" == "bench Press "),
  // using the most recent spelling. Sessions are kept newest-first.
  const allExercises = useMemo(() => {
    const seen = new Map()
    sessions.forEach(s => s.lifts.forEach(l => { const k = exKey(l.exercise); if (!seen.has(k)) seen.set(k, l.exercise.trim()) }))
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [sessions])

  // exercise key → the session where its trends were last reset (or undefined).
  const baselineMap = useMemo(() => {
    const m = {}
    sessions.forEach(s => s.lifts.forEach(l => {
      if (!l[TREND_FLAG]) return
      const k = exKey(l.exercise)
      if (!m[k] || cmpSess(s, m[k]) > 0) m[k] = s
    }))
    return m
  }, [sessions])
  // True when session s counts toward trends/PRs for exercise key k.
  const inTrend = useCallback((s, k) => !baselineMap[k] || cmpSess(s, baselineMap[k]) >= 0, [baselineMap])

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
    const oldestFirst = [...sessions].sort(cmpSess)
    oldestFirst.forEach(s => s.lifts.forEach((l, idx) => {
      const key = exKey(l.exercise)
      if (!inTrend(s, key)) return   // pre-reset sessions don't set the bar
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
  }, [sessions, inTrend])

  const streak = useMemo(() => calcStreak(sessions), [sessions])

  // Per-session TOP SET for the selected exercise, oldest → newest. "Top set" = heaviest set,
  // ties broken by reps (bestSet), so weight is the primary progressive-overload signal.
  // Each point is flagged when it beats the running best in weight-then-reps order.
  const overloadData = useMemo(() => {
    if (!progressEx) return []
    const rows = statsSessions
      .filter(s => s.lifts.some(l => eqEx(l.exercise, progressEx)))
      .map(s => {
        const lift = s.lifts.find(l => eqEx(l.exercise, progressEx))
        const top = bestSet(lift)
        return { date: fmt(s.date), fullDate: s.date, day: s.day, topW: top.weight, topR: top.reps, sets: lift.sets, session: s }
      })
      .reverse()
    const key = exKey(progressEx)
    let bestW = 0, bestR = 0
    rows.forEach(r => {
      r.preReset = !inTrend(r.session, key)
      r.isBaseline = baselineMap[key]?.id === r.session.id
      if (r.preReset) { r.weightPR = r.repPR = r.isPR = false; return }
      const weightPR = r.topW > bestW
      const repPR = !weightPR && r.topW === bestW && r.topR > bestR
      r.weightPR = weightPR
      r.repPR = repPR
      r.isPR = weightPR || repPR
      if (weightPR) { bestW = r.topW; bestR = r.topR }
      else if (r.topW === bestW && r.topR > bestR) bestR = r.topR
    })
    return rows
  }, [statsSessions, progressEx, inTrend, baselineMap])

  // Rows that count for the verdict / top-set stat (everything since the last reset).
  const trendRows = useMemo(() => overloadData.filter(r => !r.preReset), [overloadData])
  const overload = useMemo(() => analyzeOverload(trendRows), [trendRows])

  // Per-exercise progress: latest session vs previous occurrence. Used by the TRENDS view.
  const exerciseProgress = useMemo(() => {
    const groups = {}
    statsSessions.forEach(s => s.lifts.forEach(l => {
      const key = exKey(l.exercise)
      if (!inTrend(s, key)) return   // ignore sessions before a reset
      if (!groups[key]) groups[key] = []
      groups[key].push({ session: s, lift: l, displayName: l.exercise })
    }))
    const result = []
    Object.entries(groups).forEach(([key, arr]) => {
      arr.sort((a, b) => dateVal(b.session.date) - dateVal(a.session.date) || Number(b.session.id) - Number(a.session.id))
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
        resetDate: baselineMap[key]?.date || null,
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
    result.sort((a, b) => dateVal(b.latestDate) - dateVal(a.latestDate) || Number(b.latestSessionId) - Number(a.latestSessionId) || a.name.localeCompare(b.name))
    return result
  }, [statsSessions, inTrend, baselineMap])

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
    const previous = sessionsRef.current
    sessionsRef.current = sorted
    setSessions(sorted)
    setStatus('saving')
    try {
      await dbWrite(sorted)
      setStatus('ready')
      return sorted
    } catch {
      sessionsRef.current = previous
      setSessions(previous)
      setStatus('ready')
      showFlash('Save failed — try again', 'err')
      return null
    }
  }, [showFlash])

  const saveSession = async ({ goToHistory = false } = {}) => {
    if (!pending.length) return showFlash('Add at least one lift', 'err')
    const s = { id: Date.now(), date: formDate, day: formDay, gym: formGym, lifts: pending }
    // Which lifts beat their best since the last reset? (Same weight-then-reps rule as prMap.)
    const prs = pending.filter(l => {
      const k = exKey(l.exercise)
      const hist = (liftIndex[k] || []).filter(e => inTrend(e.session, k) && cmpSess(e.session, s) < 0)
      if (!hist.length) return false
      const b = bestSet(l)
      const top = hist.reduce((m, e) => { const x = bestSet(e.lift); return (x.weight > m.weight || (x.weight === m.weight && x.reps > m.reps)) ? x : m }, { weight: 0, reps: 0 })
      return b.weight > top.weight || (b.weight === top.weight && b.reps > top.reps)
    }).map(l => l.exercise)
    const result = await commitSessions([s, ...sessions])
    if (result) {
      vibrate(prs.length ? [20, 60, 40] : 20)
      setPending([]); setAddingLift(false); setEditPendIdx(null)
      showFlash(prs.length ? `🔥 PR: ${prs.join(', ')}` : formDay + ' saved! ☁️')
      if (goToHistory) setView('history')
    }
  }

  const updateSession = async updated => {
    const result = await commitSessions(sessions.map(s => s.id === updated.id ? updated : s))
    if (result) { setEditSess(null); showFlash('Session updated!') }
  }

  const deleteSession = async id => {
    const gone = sessions.find(s => s.id === id)
    if (!gone || !confirm('Delete this session?')) return
    const result = await commitSessions(sessions.filter(s => s.id !== id))
    if (result) {
      if (expandedId === id) setExpandedId(null)
      showFlash('Session deleted', 'ok', {
        label: 'UNDO',
        fn: () => commitSessions([gone, ...sessionsRef.current.filter(s => s.id !== gone.id)]).then(r => r && showFlash('Restored')),
      })
    }
  }

  // Move an exercise's trend baseline to `sessionId` (null = clear the reset).
  // Only the flag changes — every set, session and graph point is untouched.
  const setTrendBaseline = async (exercise, sessionId, { undoable = true } = {}) => {
    const k = exKey(exercise)
    const prevId = baselineMap[k]?.id ?? null
    const next = sessionsRef.current.map(s => {
      let changed = false
      const lifts = s.lifts.map(l => {
        if (exKey(l.exercise) !== k) return l
        const want = s.id === sessionId
        if (!!l[TREND_FLAG] === want) return l
        changed = true
        if (want) return { ...l, [TREND_FLAG]: true }
        const { [TREND_FLAG]: _drop, ...rest } = l   // RTDB rejects undefined values, so delete the key
        return rest
      })
      return changed ? { ...s, lifts } : s
    })
    const result = await commitSessions(next)
    if (!result) return
    vibrate(15)
    showFlash(sessionId ? `${exercise} trends reset` : `${exercise} reset removed`, 'ok',
      undoable ? { label: 'UNDO', fn: () => setTrendBaseline(exercise, prevId, { undoable: false }) } : null)
  }

  const resetTrendFrom = (exercise, session) => {
    if (!confirm(`Start ${exercise} trends fresh from ${fmt(session.date)}?\n\nEarlier sessions stay in History and on the graph — they just won't count toward PRs, UP/DOWN or the overload verdict.`)) return
    setTrendBaseline(exercise, session.id)
  }

  // Jump from a Trends row to that exercise's Progress page (canonical spelling for the <select>).
  const openProgress = name => {
    setProgressEx(allExercises.find(e => eqEx(e, name)) || name)
    setView('progress')
    window.scrollTo({ top: 0 })
  }

  const color    = COLORS[formDay]
  const isSaving = status === 'saving'

  if (status === 'unconfigured') return <SetupRequired />

  if (!authReady) return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap');@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 40, letterSpacing: 8, color: '#1a1a1a', marginBottom: 24 }}>IRON LOG</div>
      <div style={{ width: 36, height: 36, border: '3px solid #1e1e1e', borderTop: '3px solid #22c55e', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <div style={{ color: '#333', fontSize: 11, letterSpacing: 2, marginTop: 16 }}>CONNECTING TO FIREBASE</div>
    </div>
  )

  if (!user) return <SignInScreen />

  if (status === 'loading') return (
    <div style={{ background: '#090909', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap');@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 40, letterSpacing: 8, color: '#1a1a1a', marginBottom: 24 }}>IRON LOG</div>
      <div style={{ width: 36, height: 36, border: '3px solid #1e1e1e', borderTop: '3px solid #22c55e', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <div style={{ color: '#333', fontSize: 11, letterSpacing: 2, marginTop: 16 }}>LOADING SESSIONS</div>
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
        <div style={{ position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 12px)', left: '50%', transform: 'translateX(-50%)', zIndex: 999, background: flash.type === 'err' ? 'linear-gradient(180deg,#3b0a0a,#260606)' : 'linear-gradient(180deg,#0a2e1a,#062012)', border: `1px solid ${flash.type === 'err' ? '#ef444466' : '#22c55e66'}`, color: flash.type === 'err' ? '#fca5a5' : '#86efac', padding: flash.action ? '8px 8px 8px 18px' : '12px 22px', borderRadius: 12, fontSize: 13, maxWidth: 'calc(100vw - 32px)', display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)', animation: 'slideDown .28s cubic-bezier(.2,0,0,1)', fontWeight: 500 }} role="status">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flash.msg}</span>
          {flash.action && (
            <button onClick={() => { const fn = flash.action.fn; clearTimeout(flashTimer.current); setFlash(null); fn() }} style={{ flexShrink: 0, background: '#ffffff14', border: '1px solid #ffffff26', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, letterSpacing: 1.5 }}>{flash.action.label}</button>
          )}
        </div>
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
                    <div key={r.name + r.latestSessionId} role="button" tabIndex={0} onClick={() => openProgress(r.name)} onKeyDown={e => e.key === 'Enter' && openProgress(r.name)} className="session-card card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 14, marginBottom: 10, overflow: 'hidden', cursor: 'pointer', animationDelay: `${Math.min(idx, 8) * 35}ms` }}>
                      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 4, height: 50, borderRadius: 2, background: dayColor, flexShrink: 0, boxShadow: `0 0 12px ${dayColor}66` }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, color: '#fff', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                          <div style={{ fontSize: 11, color: '#9a9a9a', marginTop: 4, letterSpacing: 0.3 }}>
                            <span style={{ color: dayColor, fontWeight: 600 }}>{r.day}</span> · {fmt(r.latestDate)}
                            {r.resetDate && <span style={{ color: '#666' }}> · ↺ since {fmt(r.resetDate)}</span>}
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
                            {r.resetDate ? 'Fresh start' : 'First time'} · {r.latestMaxW === 0 ? 'BW' : r.latestMaxW}lb × {r.latestReps} reps
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
            {progressEx && overloadData.length > 0 && (() => {
              const best = trendRows.length ? trendRows.reduce((m, r) => (r.topW > m.topW || (r.topW === m.topW && r.topR > m.topR)) ? r : m, trendRows[0]) : null
              const latest = overloadData[overloadData.length - 1]
              const exK = exKey(progressEx)
              const baseSess = baselineMap[exK]
              const latestAny = liftIndex[exK]?.[0]?.session   // newest across all gyms
              const baseRow = overloadData.find(r => r.isBaseline)
              return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                  {[[baseSess ? 'BEST ↺' : 'TOP SET', best ? `${fmtW(best.topW)}×${best.topR}` : '—'], ['LATEST', `${fmtW(latest.topW)}×${latest.topR}`], ['SESSIONS', overloadData.length]].map(([label, val]) => (
                    <div key={label} className="card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 12, padding: '16px 8px', textAlign: 'center' }}>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 28, color: '#fff', letterSpacing: 1, lineHeight: 1 }}>{val}</div>
                      <div style={{ fontSize: 11, color: '#888', letterSpacing: 1.5, marginTop: 6 }}>{label}</div>
                    </div>
                  ))}
                </div>

                <div className="card" style={{ background: '#111', border: `1px solid ${overload.color}44`, borderRadius: 14, padding: '16px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 6, height: 42, borderRadius: 3, background: overload.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, letterSpacing: 3, color: overload.color, lineHeight: 1 }}>{overload.label}</div>
                    <div style={{ fontSize: 12, color: '#aaa', marginTop: 6, lineHeight: 1.45 }}>{overload.detail}</div>
                  </div>
                </div>

                {/* Trend reset: fixes comparisons after a typo'd / outlier entry without touching any data. */}
                <div className="card" style={{ background: '#0e0e0e', border: '1px solid #1c1c1c', borderRadius: 12, padding: '10px 12px 10px 14px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#888', lineHeight: 1.5 }}>
                    {baseSess
                      ? <>Trends counting from <span style={{ color: '#ddd' }}>{fmt(baseSess.date)}</span>. Older sessions are kept but don’t count.</>
                      : <>Bad entry throwing off your trends? Start fresh — history &amp; graph stay.</>}
                  </div>
                  {baseSess
                    ? <button onClick={() => setTrendBaseline(progressEx, null)} disabled={isSaving} style={{ flexShrink: 0, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#aaa', padding: '9px 12px', borderRadius: 8, fontSize: 11, letterSpacing: 1, fontWeight: 600 }}>CLEAR</button>
                    : latestAny && <button onClick={() => resetTrendFrom(progressEx, latestAny)} disabled={isSaving} style={{ flexShrink: 0, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#ddd', padding: '9px 12px', borderRadius: 8, fontSize: 11, letterSpacing: 1, fontWeight: 600 }}>↺ RESET</button>}
                </div>

                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 4 }}>TOP-SET WEIGHT</div>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 8, lineHeight: 1.4 }}>Heaviest set each session (ties broken by reps). Number above each point = reps. 🔥 = weight PR · 📈 = rep PR.{baseSess ? ' Grey = before reset.' : ''}</div>
                <div className="card" style={{ background: '#111', border: '1px solid #1f1f1f', borderRadius: 14, padding: '20px 4px 8px', marginBottom: 16 }}>
                  <ResponsiveContainer width="100%" height={210}>
                    <LineChart data={overloadData} margin={{ left: 0, right: 10, top: 6 }}>
                      <XAxis dataKey="date" tick={{ fill: '#888', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#888', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={44} unit="" />
                      <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a', fontFamily: 'DM Mono', fontSize: 12, color: '#fff', borderRadius: 8 }} labelStyle={{ color: '#888' }}
                        formatter={(v, n, p) => [`${fmtW(v)} × ${p.payload.topR} reps`, 'Top set']} />
                      {baseRow && <ReferenceLine x={baseRow.date} stroke="#555" strokeDasharray="3 3" label={{ value: '↺', position: 'insideTopLeft', fill: '#888', fontSize: 12 }} />}
                      <Line type="monotone" dataKey="topW" stroke="#22c55e" strokeWidth={2.5} isAnimationActive={false}
                        dot={({ cx, cy, payload, index }) => {
                          const fill = payload.preReset ? '#444' : payload.weightPR ? '#f59e0b' : payload.repPR ? '#06b6d4' : '#22c55e'
                          return (
                            <g key={`d-${index}`}>
                              <text x={cx} y={cy - 12} textAnchor="middle" fontSize={10} fill={payload.preReset ? '#555' : '#9a9a9a'} fontFamily="DM Mono">{payload.topR}r</text>
                              <circle cx={cx} cy={cy} r={payload.isPR ? 5 : 3.5} fill={fill} stroke={payload.isPR ? '#fff' : 'none'} strokeWidth={payload.isPR ? 1.5 : 0} />
                            </g>
                          )
                        }}
                        activeDot={{ r: 6, fill: '#22c55e' }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', fontWeight: 600, marginBottom: 10 }}>SET BY SET</div>
                {[...overloadData].reverse().map((d, i) => {
                  const c = COLORS[d.day]
                  return (
                    <div key={d.session.id} className="card" style={{ background: '#111', border: `1px solid ${d.isBaseline ? '#3a3a3a' : '#1f1f1f'}`, borderRadius: 12, padding: '12px 14px', marginBottom: 8, opacity: d.preReset ? 0.5 : 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                        <div style={{ fontSize: 13, color: '#ddd', fontWeight: 500, whiteSpace: 'nowrap' }}>{d.date}{d.isBaseline && <span style={{ color: '#888', fontSize: 10, letterSpacing: 1, marginLeft: 8 }}>↺ START</span>}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {d.isPR && <span style={{ background: d.weightPR ? '#f59e0b22' : '#06b6d422', color: d.weightPR ? '#f59e0b' : '#06b6d4', border: `1px solid ${d.weightPR ? '#f59e0b66' : '#06b6d466'}`, fontSize: 10, padding: '3px 7px', borderRadius: 5, fontWeight: 600, letterSpacing: 1 }}>{d.weightPR ? '🔥 WT PR' : '📈 REP PR'}</span>}
                          <span style={{ fontSize: 11, color: c, fontWeight: 600 }}>{d.day}</span>
                          {!d.isBaseline && <button onClick={() => resetTrendFrom(progressEx, d.session)} disabled={isSaving} aria-label="Start trends from this session" title="Start trends from here" style={{ background: '#1e1e1e', border: 'none', color: '#888', padding: '6px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Mono', monospace" }}>↺</button>}
                          <button onClick={() => setEditSess(d.session)} style={{ background: '#1e1e1e', border: 'none', color: '#888', padding: '6px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: "'DM Mono', monospace", letterSpacing: 1 }}>EDIT</button>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {d.sets.map((x, j) => <span key={j} style={{ background: c + '18', border: `1px solid ${c}33`, borderRadius: 6, padding: '5px 11px', fontSize: 13, color: c }}>S{j + 1}:{fmtW(x.weight)}×{x.reps}</span>)}
                      </div>
                    </div>
                  )
                })}
              </>
              )
            })()}
            {progressEx && overloadData.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: '60px 0', fontSize: 14 }}>No {progressEx} sessions at {gymFilter === 'ALL' ? 'any gym' : gymFilter} yet.</div>}
            {!progressEx && allExercises.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: '60px 0', fontSize: 14 }}>Log sessions first.</div>}
          </>
        )}
      </div>

      <div style={{ padding: '28px 16px 12px', marginTop: 8, borderTop: '1px solid #141414', textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: '#666', letterSpacing: 1 }}>
          SIGNED IN · <span style={{ color: '#999' }}>{user.email}</span>
        </div>
        <button onClick={() => signOutUser().catch(() => {})} style={{ marginTop: 12, background: '#0e0e0e', border: '1px solid #1f1f1f', color: '#888', padding: '9px 20px', borderRadius: 999, fontSize: 11, letterSpacing: 1.5, fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>SIGN OUT</button>
        <div style={{ fontSize: 9, color: '#2e2e2e', letterSpacing: 0.5, marginTop: 14, wordBreak: 'break-all', lineHeight: 1.5 }}>account id · {user.uid}</div>
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'rgba(13,13,13,0.92)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderTop: '1px solid #1f1f1f', display: 'flex', zIndex: 20, paddingBottom: 'env(safe-area-inset-bottom,8px)', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}>
        {[['log', IconPlus, 'LOG'], ['history', IconList, 'HISTORY'], ['trends', IconBars, 'TRENDS'], ['progress', IconTrending, 'PROGRESS']].map(([k, Ic, label]) => {
          const active = view === k
          return (
            <button key={k} onClick={() => {
              // Opening an empty Log after midnight (app left open) should default to today.
              if (k === 'log' && !pending.length && view !== 'log') { setFormDate(todayStr()); setFormGym(gymForDate(todayStr())) }
              setView(k)
            }} style={{ flex: 1, background: 'none', border: 'none', color: active ? '#fff' : '#666', padding: '14px 0 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minHeight: 60, position: 'relative' }}>
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
