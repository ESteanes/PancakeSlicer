import { useRef, useState } from 'react';
import { setState, toast } from '../state/store';
import { setProjectsQuery } from './query';
import type { OpenProjectsState } from './open-projects';
import './open-projects.css';

export function OpenProjects({ discovery, query, current }: { discovery: OpenProjectsState; query: string; current: string }) {
  const { projects, error, refreshing, refresh } = discovery;
  const [joining, setJoining] = useState<string | null>(null);
  const opening = useRef(false);
  const join = async (id: string) => {
    if (opening.current) return;
    opening.current = true;
    setJoining(id);
    try {
      const flow = await import('../flow/project');
      await flow.openProject(id);
      const { context, value } = flow.project.get();
      if (context.id !== id || context.loadError || ['missing', 'deleted', 'opening'].includes(value))
        throw new Error(context.error || 'This project could not be opened. It may have been deleted.');
      setState({ tab: 'prepare', sessionDialog: null });
    } catch (error) {
      toast('couldnt_join_project', { detail: error instanceof Error ? error.message : String(error) });
    } finally {
      opening.current = false;
      setJoining(null);
    }
  };
  const q = query.trim().toLocaleLowerCase();
  const shown = projects?.filter(({ project }) => project.name.toLocaleLowerCase().includes(q)) ?? [];
  const total = projects?.reduce((n, p) => n + p.viewers.length, 0) ?? 0;
  return <div className="pj-scroll scroll-fade">
    <div className="pj-live-intro">
      <div>
        <p>Projects currently open on this server. Join to view or edit together.</p>
        <span className="pj-live-hint">Updates every 5 seconds. Each connected browser tab counts as one viewer.</span>
      </div>
      <button type="button" className="btn" disabled={refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {error ? <div className="pj-empty" role="alert">
      <strong>Couldn’t load open projects</strong><span>{error}</span>
      <span>Reconnecting automatically. Live presence is unavailable until the connection returns.</span>
      <button type="button" className="btn" disabled={refreshing} onClick={refresh}>{refreshing ? 'Retrying…' : 'Retry now'}</button>
    </div> : !projects ? <div className="pj-empty" role="status">Finding open projects…</div>
      : projects.length === 0 ? <div className="pj-empty">
        <strong>No projects open right now</strong>
        <span>Open a saved project to make it appear here for others on this server.</span>
      </div> : <>
        <div className="pj-live-summary" role="status">
          <span className="pj-live-dot" aria-hidden/>
          {projects.length} {projects.length === 1 ? 'project' : 'projects'} open · {total} connected {total === 1 ? 'tab' : 'tabs'}
        </div>
        {shown.length === 0 ? <div className="pj-empty"><strong>No open projects match</strong><button type="button" className="btn" onClick={() => setProjectsQuery('')}>Clear search</button></div>
          : <ul className="pj-live-grid" aria-label="Open projects">
            {shown.map(({ project: p, viewers }) => <li key={p.id} className={`pj-live-card${p.id === current ? ' current' : ''}`}>
              <div className="pj-thumb">
                {p.thumbnail && p.objects > 0 ? <img src={p.thumbnail} alt="" loading="lazy" decoding="async"/>
                  : <span className="pj-thumb-empty">{p.objects > 0 ? 'No preview' : 'Empty project'}</span>}
                <span className="pj-live-badge"><span className="pj-live-dot" aria-hidden/>{viewers.length} {viewers.length === 1 ? 'viewer' : 'viewers'}</span>
              </div>
              <div className="pj-live-body">
                <h2>{p.name}</h2>
                <span className="pj-live-hint">{p.objects} {p.objects === 1 ? 'object' : 'objects'}{p.id === current ? ' · Open in this tab' : ''}</span>
                <ul className="pj-live-viewers" tabIndex={viewers.length > 4 ? 0 : undefined} aria-label={`Connected viewers in ${p.name}`}>
                  {viewers.map((viewer, index) => <li key={`${viewer.since}:${index}`}><span>{viewer.label}</span>{viewer.mine && <span className="pj-live-you">You</span>}</li>)}
                </ul>
                <button type="button" className={p.id === current ? 'btn' : 'btn-primary'} disabled={joining !== null}
                  aria-label={`${p.id === current ? 'Return to' : 'Join'} ${p.name}`} aria-busy={joining === p.id} onClick={() => void join(p.id)}>
                  {joining === p.id ? 'Opening…' : p.id === current ? 'Return to project' : 'Join project'}
                </button>
              </div>
            </li>)}
          </ul>}
      </>}
  </div>;
}
