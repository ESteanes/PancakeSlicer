import { useEffect, useState } from 'react';
import { sessionId } from '../api/session';
import { collaborative } from '../persist/project-collaboration';
import { serviceJson } from '../persist/service';
import { clean, type ListedProject } from './api';

export interface ProjectViewer { label: string; since: number; mine: boolean }
export interface OpenProject { project: ListedProject; viewers: ProjectViewer[] }

function readProjects(value: unknown): OpenProject[] {
  if (!Array.isArray(value)) throw new Error('The service did not return a list of open projects.');
  const projects: OpenProject[] = [];
  for (const row of value) {
    const project = clean(row?.project);
    if (!project || !Array.isArray(row.viewers)) continue;
    const viewers = row.viewers.filter((viewer: unknown): viewer is ProjectViewer => {
      if (!viewer || typeof viewer !== 'object') return false;
      const v = viewer as Partial<ProjectViewer>;
      return typeof v.label === 'string' && typeof v.since === 'number' && Number.isFinite(v.since) && typeof v.mine === 'boolean';
    });
    if (viewers.length) projects.push({ project, viewers });
  }
  return projects.sort((a, b) => b.viewers.length - a.viewers.length || a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id));
}

export function useOpenProjects() {
  const enabled = collaborative();
  const [projects, setProjects] = useState<OpenProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let next: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const poll = async () => {
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      setRefreshing(true);
      try {
        const rows = await serviceJson<unknown>('/api/projects/open', {
          cache: 'no-store', signal: controller.signal, headers: { 'X-Orca-Session': sessionId },
        });
        const found = readProjects(rows);
        if (active) { setProjects(found); setError(null); }
      } catch (error) {
        if (active) {
          setProjects(null);
          setError(controller.signal.aborted ? 'The service took too long to respond.' : error instanceof Error ? error.message : 'The service could not be reached.');
        }
      } finally {
        clearTimeout(timeout);
        if (active) { setRefreshing(false); next = setTimeout(() => void poll(), 5_000); }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(next); request?.abort(); };
  }, [enabled, revision]);
  return { enabled, projects, error, refreshing, refresh: () => setRevision(n => n + 1) };
}

export type OpenProjectsState = ReturnType<typeof useOpenProjects>;
