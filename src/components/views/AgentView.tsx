"use client";

import { agentLabel, timeOf, type AppState } from "@/lib/client";

function Lane({ name, state, detail, active }: { name: string; state: string; detail?: string; active: boolean }) {
  return (
    <li className={`lane ${active ? "lane-active" : ""}`}>
      <div className="lane-head">
        <span className="lane-name">{name}</span>
        <span className="lane-state">{state}</span>
      </div>
      {detail && <p className="lane-task">{detail}</p>}
      {active && <span className="lane-bar" aria-hidden="true" />}
    </li>
  );
}

export function AgentView({ state, onOpen }: { state: AppState; onOpen: (id: number) => void }) {
  const { tasks, events, review, config } = state;
  const workers = Array.from({ length: config.workerConcurrency }, (_, i) => `worker-${i + 1}`);
  const queued = tasks.filter((t) => t.status === "working" && !t.agent).length;
  const sorting = tasks.filter((t) => t.status === "triaging").length;

  const reviewing = tasks.filter((t) => t.status === "reviewing");
  const ids = new Set(reviewing.map((t) => t.id));
  const latest = events.find((e) => e.agent === "reviewer" && e.kind === "start" && e.task_id && ids.has(e.task_id));
  const current = reviewing.find((t) => t.id === latest?.task_id) ?? reviewing[0];

  return (
    <div className="agentview">
      <section className="panel" aria-labelledby="floor-h">
        <header className="panel-head">
          <h2 id="floor-h">Agent floor</h2>
          <p>{config.workerConcurrency} workers work in parallel. One reviewer checks every result.</p>
        </header>
        <ul className="lanes">
          <Lane name="Sorting" state={sorting ? `${sorting} to sort` : "Idle"} active={sorting > 0} detail={sorting ? "Deciding who does what" : undefined} />
          {workers.map((w) => {
            const task = tasks.find((t) => t.status === "working" && t.agent === w);
            return <Lane key={w} name={agentLabel(w)} state={task ? "Working" : "Idle"} active={!!task} detail={task?.title} />;
          })}
          <Lane name="Reviewer" state={current ? "Checking" : "Idle"} active={!!current} detail={current?.title} />
        </ul>
        {(queued > 0 || reviewing.length > 1) && (
          <p className="floor-queue">
            {queued > 0 && `${queued} waiting for a worker. `}
            {reviewing.length > 1 && `${reviewing.length - 1} waiting for review.`}
          </p>
        )}
        <div className="floor-stats" aria-label="Reviewer verdicts">
          <div>
            <strong>{review.passed}</strong>
            <span>passed</span>
          </div>
          <div>
            <strong>{review.revised}</strong>
            <span>sent back</span>
          </div>
          <div>
            <strong>{review.flagged}</strong>
            <span>flagged for you</span>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="act-h">
        <header className="panel-head">
          <h2 id="act-h">Activity</h2>
          <p>The last {events.length} steps, newest first.</p>
        </header>
        {events.length ? (
          <ol className="feed feed-wide">
            {events.map((e) => (
              <li key={e.id} className={e.kind === "error" ? "feed-error" : ""}>
                <time>{timeOf(e.ts)}</time>
                <span className="feed-agent">{agentLabel(e.agent)}</span>
                {e.task_id ? (
                  <button className="feed-msg feed-link" onClick={() => onOpen(e.task_id!)}>
                    {e.message}
                  </button>
                ) : (
                  <span className="feed-msg">{e.message}</span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="quiet-note">Nothing yet. Add a task and you will see each step here.</p>
        )}
      </section>
    </div>
  );
}
