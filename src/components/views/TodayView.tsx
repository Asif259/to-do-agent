"use client";

import { isBusy, PILE_META, suggestionsFor, type AppState, type Health, type TaskCardT } from "@/lib/client";
import { PILES } from "@/lib/types";
import { Icon } from "../ui";
import { SAMPLE_TASKS } from "../QuickAdd";
import { TaskRow } from "../TaskRow";

function Section({ title, hint, tasks, ...row }: { title: string; hint?: string; tasks: TaskCardT[] } & RowProps) {
  if (!tasks.length) return null;
  return (
    <section className="section" aria-label={title}>
      <header className="section-head">
        <h2>{title}</h2>
        <span className="count">{tasks.length}</span>
        {hint && <p>{hint}</p>}
      </header>
      <ul className="rows">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} showPile selected={row.selectedId === t.id} onSelect={row.onSelect} onToggle={row.onToggle} onRetry={row.onRetry} />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  selectedId: number | null;
  onSelect: (id: number) => void;
  onToggle: (t: TaskCardT) => void;
  onRetry: (id: number) => void;
}

function Onboarding({ health, onModels, onSample }: { health: Health | null; onModels: () => void; onSample: () => void }) {
  const live = health?.mode === "live";
  const modelReady = !live || (health?.total ?? 0) > 0;
  return (
    <section className="onboarding" aria-label="Getting started">
      <h2>Three steps to a working agent</h2>
      <ol>
        <li className={modelReady ? "step-complete" : ""}>
          <span className="step-num">{modelReady ? <Icon name="check" size={14} /> : 1}</span>
          <div>
            <h3>Connect a model</h3>
            <p>{live ? "Add an API key from OpenRouter, Groq, Gemini or any OpenAI-compatible provider. Free tiers work." : "Demo mode is on, so no key is needed. Results are placeholders."}</p>
            {live && (
              <button className={`btn btn-sm ${modelReady ? "" : "btn-primary"}`} onClick={onModels}>
                <Icon name="sliders" size={14} /> {modelReady ? "Manage models" : "Add an API key"}
              </button>
            )}
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div>
            <h3>Hand over your tasks</h3>
            <p>Type in the bar above, one task per line, or paste a whole list. The agent sorts each task and starts on it.</p>
            <button className="btn btn-sm" onClick={onSample}>
              Try sample tasks
            </button>
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <h3>Review what comes back</h3>
            <p>Finished work waits here for you to accept. Anything the agent writes to someone is a draft you approve and send yourself.</p>
          </div>
        </li>
      </ol>
    </section>
  );
}

export function TodayView({
  state,
  health,
  onModels,
  onSample,
  onStart,
  onSuggest,
  ...row
}: {
  state: AppState;
  health: Health | null;
  onModels: () => void;
  onSample: () => void;
  onStart: () => void;
  onSuggest: (text: string) => void;
} & RowProps) {
  const open = state.tasks.filter((t) => t.status !== "done");
  const failed = open.filter((t) => t.status === "failed");
  const needs = open.filter((t) => t.status === "needs_you");
  const ready = open.filter((t) => t.status === "ready");
  const busy = open.filter((t) => isBusy(t.status));
  const queued = open.filter((t) => t.status === "inbox");
  const { stats } = state;
  const ideas = suggestionsFor(state.tasks);
  const split = PILES.map((p) => ({ pile: p, n: state.tasks.filter((t) => t.pile === p).length }));
  const sorted = split.reduce((n, s) => n + s.n, 0);

  return (
    <div className="today">
      <div className="today-list">
        {sorted > 0 && (
          <section className="band" aria-label="Who does the work">
            <div className="band-bar" role="img" aria-label={split.map((s) => `${s.n} ${PILE_META[s.pile].title}`).join(", ")}>
              {split.filter((s) => s.n > 0).map((s) => (
                <span key={s.pile} className={`band-seg band-${s.pile}`} style={{ flexGrow: s.n }} />
              ))}
            </div>
            <ul className="band-key">
              {split.map((s) => (
                <li key={s.pile}>
                  <i className={`band-${s.pile}`} aria-hidden="true" />
                  <strong>{s.n}</strong> {PILE_META[s.pile].title}
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.tasks.length > 0 && (
          <div className="figures" aria-label="Your numbers">
            <div className="figure">
              <strong>{stats.minutesSavedToday >= 60 ? `${(stats.minutesSavedToday / 60).toFixed(1)} h` : `${stats.minutesSavedToday} min`}</strong>
              <span>Time saved today (estimate)</span>
            </div>
            <div className="figure">
              <strong>{stats.finishedThisWeek}</strong>
              <span>Finished this week</span>
            </div>
            <div className="figure">
              <strong>{stats.delegationScore === null ? "–" : `${stats.delegationScore}%`}</strong>
              <span>Delegation score</span>
            </div>
          </div>
        )}

        {queued.length > 0 && (
          <div className="callout callout-start" role="status">
            <Icon name="play" size={18} />
            <span>
              <strong>
                {queued.length} {queued.length === 1 ? "task is" : "tasks are"} queued
              </strong>
              <small>The agent sorts each one, works them in parallel, and a reviewer checks the results.</small>
            </span>
            <button className="btn btn-primary" onClick={onStart}>
              Get it done
            </button>
          </div>
        )}

        {state.tasks.length === 0 ? (
          <Onboarding health={health} onModels={onModels} onSample={onSample} />
        ) : open.length === 0 ? (
          <p className="empty">Nothing is open. Add something above, or look back at finished work on the Board.</p>
        ) : (
          <>
            <Section title="Needs attention" hint="The agent could not finish these." tasks={failed} {...row} />
            <Section title="Needs you" hint="Your part is next." tasks={needs} {...row} />
            <Section title="Ready to accept" hint="Finished and reviewed." tasks={ready} {...row} />
            <Section title="In progress" tasks={busy} {...row} />
            <Section title="Queued" hint="Waiting for you to click Get it done." tasks={queued} {...row} />
          </>
        )}
        {ideas.length > 0 && (
          <section className="suggest" aria-label="Suggested tasks">
            <h2>Suggested next</h2>
            <div className="suggest-list">
              {ideas.map((i) => (
                <button key={i} className="btn btn-sm" onClick={() => onSuggest(i)}>
                  <Icon name="plus" size={13} /> {i}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
