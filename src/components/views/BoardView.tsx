"use client";

import { useMemo, useState } from "react";
import { CATEGORIES_ORDER, CATEGORY_LABEL, isBusy, PILE_META, type TaskCardT } from "@/lib/client";
import { PILES } from "@/lib/types";
import { Icon } from "../ui";
import { TaskRow } from "../TaskRow";

export function BoardView({
  tasks,
  selectedId,
  onSelect,
  onToggle,
  onRetry,
}: {
  tasks: TaskCardT[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onToggle: (t: TaskCardT) => void;
  onRetry: (id: number) => void;
}) {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const t of tasks) {
      if (t.status === "done" && !showDone) continue;
      c.all++;
      c[t.category] = (c[t.category] ?? 0) + 1;
    }
    return c;
  }, [tasks, showDone]);

  const q = query.trim().toLowerCase();
  const visible = tasks.filter(
    (t) => (showDone || t.status !== "done") && (category === "all" || t.category === category) && (!q || `${t.title} ${t.summary ?? ""}`.toLowerCase().includes(q)),
  );
  const unsorted = visible.filter((t) => !t.pile);
  const doneCount = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="board">
      <div className="filters">
        <div className="chips" role="group" aria-label="Filter by category">
          {(["all", ...CATEGORIES_ORDER] as const).map((c) => (
            <button key={c} className="fchip" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c === "all" ? "All" : CATEGORY_LABEL[c]}
              <span>{counts[c] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="filters-right">
          <label className="search">
            <Icon name="search" size={15} />
            <input id="board-search" type="search" placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tasks" />
            {!query && <kbd>/</kbd>}
          </label>
          <label className="toggle-line">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            <span>Show done ({doneCount})</span>
          </label>
        </div>
      </div>

      {unsorted.length > 0 && (
        <section className="section" aria-label="Being sorted">
          <header className="section-head">
            <h2>Being sorted</h2>
            <span className="count">{unsorted.length}</span>
          </header>
          <ul className="rows rows-flat">
            {unsorted.map((t) => (
              <TaskRow key={t.id} task={t} showPile={false} selected={selectedId === t.id} onSelect={onSelect} onToggle={onToggle} onRetry={onRetry} />
            ))}
          </ul>
        </section>
      )}

      <div className="piles">
        {PILES.map((p) => {
          const list = visible.filter((t) => t.pile === p);
          const openCount = list.filter((t) => t.status !== "done").length;
          return (
            <section key={p} className={`pile pile-${p}`} aria-labelledby={`pile-${p}`}>
              <header className="pile-head">
                <div className="pile-title-row">
                  <h2 id={`pile-${p}`}>{PILE_META[p].title}</h2>
                  <span className="pile-count" aria-label={`${openCount} open`}>
                    {openCount}
                  </span>
                </div>
                <p>{PILE_META[p].caption}</p>
              </header>
              {list.length ? (
                <ul className="rows">
                  {list.map((t) => (
                    <TaskRow key={t.id} task={t} showPile={false} selected={selectedId === t.id} onSelect={onSelect} onToggle={onToggle} onRetry={onRetry} />
                  ))}
                </ul>
              ) : (
                <p className="pile-empty">{category !== "all" || q ? "Nothing matches your filter." : PILE_META[p].empty}</p>
              )}
            </section>
          );
        })}
      </div>
      {tasks.some((t) => isBusy(t.status)) && <p className="quiet-note">The agent is working. This board updates by itself.</p>}
    </div>
  );
}
