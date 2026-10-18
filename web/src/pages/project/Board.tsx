import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, PRIORITIES, qs, type Board, type Card, type Column } from '../../api';
import { ErrorBox, Spinner, useToast } from '../../components/ui';
import { colorVar, timeAgo } from '../../lib/format';
import { canDo } from '../../lib/project';
import CardDrawer from './CardDrawer';
import { useProjectCtx } from './ProjectLayout';

const PAGE = 60;
const NO_AREA = 'none';

function readCollapsed(boardId: string, columns: Column[]): Set<string> {
  try {
    const raw = localStorage.getItem(`hsl-collapsed-${boardId}`);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set(columns.filter((c) => c.category === 'closed').map((c) => c.id));
}

function CardTile({ card, recent, onOpen, overlay, draggable }: { card: Card; recent?: boolean; onOpen?: () => void; overlay?: boolean; draggable: boolean }) {
  const s = useSortable({ id: card.id, data: { card }, disabled: !draggable || overlay });
  const style = overlay ? undefined : { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div
      ref={overlay ? undefined : s.setNodeRef}
      style={style}
      className={`kcard ${s.isDragging && !overlay ? 'dragging' : ''} ${overlay ? 'overlay' : ''} ${recent ? 'recent' : ''}`}
      onClick={onOpen}
      {...(overlay ? {} : s.attributes)}
      {...(overlay ? {} : s.listeners)}
    >
      <div className="k-title">{card.title}</div>
      <div className="k-meta">
        <span className="k-key">{card.key}</span>
        {card.priority && <span className={`prio ${card.priority}`}>{card.priority}</span>}
        {card.area_name && <span className="k-area">{card.area_name}</span>}
        {card.tags.map((t) => <span key={t} className="tag">{t}</span>)}
        {card.estimate && <span>⏱ {card.estimate}</span>}
        {card.comment_count > 0 && <span title="Comments">💬 {card.comment_count}</span>}
        {card.attachment_count > 0 && <span title="Attachments">📎 {card.attachment_count}</span>}
        {card.assignee_name && <span title="Assignee">@{card.assignee_name.split(' ')[0]}</span>}
      </div>
    </div>
  );
}

function ColumnView({
  col, cards, laneId, collapsed, onToggle, recent, openCard, canMove, canCreate, onQuickAdd,
}: {
  col: Column; cards: Card[]; laneId: string; collapsed: boolean; onToggle: () => void; recent: Record<string, number>;
  openCard: (c: Card) => void; canMove: boolean; canCreate: boolean; onQuickAdd: (title: string) => Promise<void>;
}) {
  const drop = useDroppable({ id: `col:${col.id}:${laneId}`, data: { columnId: col.id, laneId } });
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const over = col.wip_limit && cards.length > col.wip_limit;
  if (collapsed) {
    return (
      <div ref={drop.setNodeRef} className={`col collapsed ${drop.isOver ? 'over' : ''}`} onClick={onToggle} title={`Show ${col.name}`}>
        <div className="col-hd"><span className="dot" style={{ background: colorVar(col.color) }} />{col.name}<span className="count">{cards.length}</span></div>
      </div>
    );
  }
  const shown = cards.slice(0, limit);
  return (
    <div ref={drop.setNodeRef} className={`col ${drop.isOver ? 'over' : ''}`}>
      <div className="col-hd">
        <span className="dot" style={{ background: colorVar(col.color) }} />
        <span>{col.name}</span>
        <span className={`count ${over ? 'wip-over' : ''}`}>{cards.length}{col.wip_limit ? ` / ${col.wip_limit}` : ''}</span>
        <div className="col-actions">
          {canCreate && <button className="btn ghost sm icon" title="Add card" onClick={() => setAdding(true)}>＋</button>}
          <button className="btn ghost sm icon" title="Collapse column" onClick={onToggle}>‹</button>
        </div>
      </div>
      <div className="col-body">
        {adding && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await onQuickAdd(title.trim());
            setTitle('');
          }}>
            <textarea className="input" style={{ minHeight: 60 }} autoFocus placeholder="Card title — Enter to add, Esc to stop" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); }
                if (e.key === 'Escape') { setAdding(false); setTitle(''); }
              }}
              onBlur={() => !title && setAdding(false)} />
          </form>
        )}
        <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {shown.map((c) => <CardTile key={c.id} card={c} recent={!!recent[c.id]} onOpen={() => openCard(c)} draggable={canMove} />)}
        </SortableContext>
        {cards.length > limit && <div className="col-more"><button className="btn ghost sm" onClick={() => setLimit(limit + PAGE * 2)}>Show {Math.min(cards.length - limit, PAGE * 2)} more of {cards.length - limit}</button></div>}
        {!cards.length && !adding && canCreate && <button className="add-card" onClick={() => setAdding(true)}>+ Add card</button>}
      </div>
    </div>
  );
}

type SortKey = 'key' | 'title' | 'column' | 'area' | 'priority' | 'updated';
const prioRank = (p: string | null) => (p ? PRIORITIES.indexOf(p as any) : 9);

function TableView({ board, cards, openCard }: { board: Board; cards: Card[]; openCard: (c: Card) => void }) {
  const [sort, setSort] = useState<{ k: SortKey | string; dir: 1 | -1 }>({ k: 'column', dir: 1 });
  const colSort = new Map(board.columns.map((c) => [c.id, c.sort]));
  const shortFields = board.field_defs.filter((f) => f.type !== 'longtext');
  const sorted = useMemo(() => {
    const val = (c: Card): any => {
      switch (sort.k) {
        case 'key': return c.number;
        case 'title': return c.title.toLowerCase();
        case 'column': return (colSort.get(c.column_id) ?? 0) * 1e9 + c.sort;
        case 'area': return c.area_name ?? '~';
        case 'priority': return prioRank(c.priority);
        case 'updated': return c.updated_at;
        default: return c.fields[sort.k] ?? '';
      }
    };
    return [...cards].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  }, [cards, sort]);
  const th = (k: string, label: string, cls = '') => (
    <th className={`sortable ${cls}`} onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : 1 }))}>{label}{sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>
  );
  return (
    <div className="page" style={{ paddingTop: 12 }}>
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{th('key', 'Key')}{th('title', 'Title')}{th('column', 'Status')}{th('area', 'Area')}{th('priority', 'Priority')}<th>Tags</th>{shortFields.map((f) => th(f.key, f.label))}{th('updated', 'Updated')}</tr></thead>
          <tbody>
            {sorted.map((c) => {
              const col = board.columns.find((x) => x.id === c.column_id);
              return (
                <tr key={c.id} className="clickable" onClick={() => openCard(c)}>
                  <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>{c.key}</td>
                  <td style={{ minWidth: 240 }}><div style={{ fontWeight: 550 }}>{c.title}</div>{c.description && <div className="faint small" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: colorVar(col?.color ?? '') }} />{c.column_name}</span></td>
                  <td>{c.area_name}</td>
                  <td>{c.priority && <span className={`prio ${c.priority}`}>{c.priority}</span>}</td>
                  <td>{c.tags.map((t) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</td>
                  {shortFields.map((f) => <td key={f.key} className="small">{f.type === 'bool' ? (c.fields[f.key] === true ? 'Yes' : c.fields[f.key] === false ? 'No' : '') : String(c.fields[f.key] ?? '')}</td>)}
                  <td className="faint small" style={{ whiteSpace: 'nowrap' }}>{timeAgo(c.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sorted.length && <div className="empty">No cards match.</div>}
      </div>
      <div className="faint small" style={{ marginTop: 8 }}>{sorted.length} cards</div>
    </div>
  );
}

export default function BoardPage() {
  const { project, recent } = useProjectCtx();
  const { board: boardKey } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const board = project.boards.find((b) => b.key === boardKey);
  const archived = sp.get('archived') === '1';
  const queryKey = ['cards', project.key, boardKey, archived];
  const cardsQ = useQuery({
    queryKey,
    queryFn: () => api.get<Card[]>(`/api/projects/${project.key}/cards${qs({ board: boardKey, archived: archived || undefined, limit: 5000 })}`),
    enabled: !!board,
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (board) setCollapsed(readCollapsed(board.id, board.columns));
  }, [board?.id]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const view = sp.get('view') ?? 'board';
  const group = sp.get('group') ?? '';
  const f = { q: sp.get('q') ?? '', area: sp.get('area') ?? '', priority: sp.get('priority') ?? '', tag: sp.get('tag') ?? '', column: sp.get('column') ?? '', assignee: sp.get('assignee') ?? '' };

  const cards = cardsQ.data ?? [];
  const filtered = useMemo(() => {
    const needle = f.q.toLowerCase();
    return cards.filter((c) =>
      (!f.area || (f.area === NO_AREA ? !c.area_id : c.area_id === f.area)) &&
      (!f.priority || c.priority === f.priority) &&
      (!f.tag || c.tags.includes(f.tag)) &&
      (!f.column || c.column_id === f.column) &&
      (!f.assignee || c.assignee_id === f.assignee) &&
      (!needle || c.key.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle) || JSON.stringify(c.fields).toLowerCase().includes(needle)),
    );
  }, [cards, f.q, f.area, f.priority, f.tag, f.column, f.assignee]);
  const tags = useMemo(() => [...new Set(cards.flatMap((c) => c.tags))].sort(), [cards]);
  const assignees = useMemo(() => [...new Map(cards.filter((c) => c.assignee_id).map((c) => [c.assignee_id!, c.assignee_name!])).entries()], [cards]);

  if (!board) return <div className="page"><ErrorBox error="Board not found" /></div>;
  const canMove = canDo(project, 'card.move') && !archived;
  const canCreate = canDo(project, 'card.create') && !archived;
  const openKey = sp.get('card');
  const openCard = (c: Card) => set('card', c.key);
  const toggle = (id: string) => {
    const n = new Set(collapsed);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setCollapsed(n);
    try { localStorage.setItem(`hsl-collapsed-${board.id}`, JSON.stringify([...n])); } catch { /* ignore */ }
  };
  const filtersOn = Object.values(f).some(Boolean);

  const lanes: { id: string; name: string }[] = group === 'area'
    ? [...project.areas.filter((a) => filtered.some((c) => c.area_id === a.id)).map((a) => ({ id: a.id, name: a.name })), ...(filtered.some((c) => !c.area_id) ? [{ id: NO_AREA, name: 'No area' }] : [])]
    : [{ id: 'all', name: '' }];
  const inLane = (laneId: string, colId: string) => filtered.filter((c) => c.column_id === colId && (laneId === 'all' || (laneId === NO_AREA ? !c.area_id : c.area_id === laneId)));

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over) return;
    const card = cards.find((c) => c.id === e.active.id);
    if (!card) return;
    let columnId: string;
    let laneId: string;
    let index: number | 'bottom' = 'bottom';
    const overCard = e.over.data.current?.card as Card | undefined;
    if (overCard) {
      if (overCard.id === card.id) return;
      columnId = overCard.column_id;
      laneId = group === 'area' ? overCard.area_id ?? NO_AREA : 'all';
      // Index within the full column (not just the filtered view), excluding the dragged card.
      const full = cards.filter((c) => c.column_id === columnId && c.id !== card.id).sort((a, b) => a.sort - b.sort);
      const i = full.findIndex((c) => c.id === overCard.id);
      const sameCol = card.column_id === columnId;
      const movingDown = sameCol && card.sort < overCard.sort;
      index = i < 0 ? 'bottom' : movingDown ? i + 1 : i;
    } else {
      columnId = e.over.data.current?.columnId;
      laneId = e.over.data.current?.laneId;
      if (!columnId) return;
    }
    const newArea = group === 'area' && laneId !== 'all' ? (laneId === NO_AREA ? null : laneId) : undefined;
    const areaChanged = newArea !== undefined && newArea !== card.area_id;
    if (columnId === card.column_id && index === 'bottom' && !overCard && !areaChanged) return;
    // Optimistic: place the card where it was dropped.
    const prev = qc.getQueryData<Card[]>(queryKey);
    const col = board.columns.find((c) => c.id === columnId)!;
    qc.setQueryData<Card[]>(queryKey, (old) => {
      if (!old) return old;
      const others = old.filter((c) => c.column_id === columnId && c.id !== card.id).sort((a, b) => a.sort - b.sort);
      const i = index === 'bottom' ? others.length : index;
      const before = others[i - 1]?.sort ?? (others[0] ? others[0].sort - 2048 : 0);
      const after = others[i]?.sort ?? before + 2048;
      return old.map((c) => (c.id === card.id ? { ...c, column_id: columnId, column_name: col.name, sort: (before + after) / 2, ...(areaChanged ? { area_id: newArea!, area_name: project.areas.find((a) => a.id === newArea)?.name ?? null } : {}) } : c));
    });
    try {
      if (areaChanged) await api.patch(`/api/cards/${card.key}`, { area: newArea });
      if (columnId !== card.column_id || overCard) await api.post(`/api/cards/${card.key}/move`, { column: columnId, index });
      if (columnId !== card.column_id) toast(`${card.key} moved to ${col.name}`);
    } catch (err) {
      qc.setQueryData(queryKey, prev);
      toast(err instanceof Error ? err.message : 'Move failed', 'error');
    } finally {
      qc.invalidateQueries({ queryKey: ['cards', project.key] });
      qc.invalidateQueries({ queryKey: ['project', project.key] });
    }
  };

  const quickAdd = (colId: string, laneId: string) => async (title: string) => {
    try {
      const area = laneId !== 'all' && laneId !== NO_AREA ? laneId : f.area && f.area !== NO_AREA ? f.area : undefined;
      const c = await api.post<Card>(`/api/projects/${project.key}/boards/${board.key}/cards`, { title, column: colId, area });
      qc.invalidateQueries({ queryKey: ['cards', project.key] });
      qc.invalidateQueries({ queryKey: ['project', project.key] });
      toast(`Created ${c.key}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create card', 'error');
    }
  };

  const active = activeId ? cards.find((c) => c.id === activeId) : null;

  return (
    <div className="board-page">
      <div className="toolbar">
        <input className="input sm search" placeholder="Search cards…" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select className="input sm" value={f.area} onChange={(e) => set('area', e.target.value)}>
          <option value="">All areas</option>
          {project.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value={NO_AREA}>No area</option>
        </select>
        <select className="input sm" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </select>
        {tags.length > 0 && (
          <select className="input sm" value={f.tag} onChange={(e) => set('tag', e.target.value)}>
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {assignees.length > 0 && (
          <select className="input sm" value={f.assignee} onChange={(e) => set('assignee', e.target.value)}>
            <option value="">Anyone</option>
            {assignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {view === 'table' && (
          <select className="input sm" value={f.column} onChange={(e) => set('column', e.target.value)}>
            <option value="">All statuses</option>
            {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {filtersOn && <button className="btn ghost sm" onClick={() => setSp(new URLSearchParams(view !== 'board' ? { view } : {}), { replace: true })}>Clear</button>}
        <span className="grow" />
        <span className="faint small">{filtered.length}{filtersOn ? ` of ${cards.length}` : ''} cards</span>
        <label className="check small"><input type="checkbox" checked={archived} onChange={(e) => set('archived', e.target.checked ? '1' : null)} /> Archived</label>
        {view === 'board' && (
          <div className="seg">
            <button className={group !== 'area' ? 'on' : ''} onClick={() => set('group', null)}>Columns</button>
            <button className={group === 'area' ? 'on' : ''} onClick={() => set('group', 'area')}>By area</button>
          </div>
        )}
        <div className="seg">
          <button className={view === 'board' ? 'on' : ''} onClick={() => set('view', null)}>Board</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => set('view', 'table')}>Table</button>
        </div>
      </div>

      {cardsQ.isLoading ? <Spinner /> : cardsQ.error ? <div className="page"><ErrorBox error={cardsQ.error} /></div> : view === 'table' ? (
        <TableView board={board} cards={filtered} openCard={openCard} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
          {group === 'area' ? (
            <div className="lanes">
              {lanes.map((lane) => (
                <div key={lane.id} className="lane">
                  <div className="lane-hd">{lane.name}<span className="faint small">{filtered.filter((c) => (lane.id === NO_AREA ? !c.area_id : c.area_id === lane.id)).length}</span></div>
                  <div className="board">
                    {board.columns.map((col) => (
                      <ColumnView key={col.id} col={col} cards={inLane(lane.id, col.id)} laneId={lane.id} collapsed={collapsed.has(col.id)} onToggle={() => toggle(col.id)}
                        recent={recent} openCard={openCard} canMove={canMove} canCreate={canCreate} onQuickAdd={quickAdd(col.id, lane.id)} />
                    ))}
                  </div>
                </div>
              ))}
              {!lanes.length && <div className="empty">No cards match.</div>}
            </div>
          ) : (
            <div className="board">
              {board.columns.map((col) => (
                <ColumnView key={col.id} col={col} cards={inLane('all', col.id)} laneId="all" collapsed={collapsed.has(col.id)} onToggle={() => toggle(col.id)}
                  recent={recent} openCard={openCard} canMove={canMove} canCreate={canCreate} onQuickAdd={quickAdd(col.id, 'all')} />
              ))}
            </div>
          )}
          <DragOverlay>{active ? <CardTile card={active} overlay draggable={false} /> : null}</DragOverlay>
        </DndContext>
      )}
      {openKey && <CardDrawer cardKey={openKey} project={project} onClose={() => set('card', null)} />}
    </div>
  );
}
